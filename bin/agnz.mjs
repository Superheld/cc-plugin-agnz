#!/usr/bin/env node
// agnz CLI — the parent's interface to the local-model sub-agent (replaces
// the old MCP tool surface). Verbs:
//
//   agnz start  <name> ["task"] --agent <def> | --inline "<frontmatter>"
//                              [--cwd .] [--description "..."] [--wait]
//   agnz send   <name|id> "message"   [--wait]
//   agnz approve <id> allow|deny      [--persist]
//   agnz answer <id> "answer text"
//   agnz stop   <id>
//   agnz list   [--status <s>] [--all]
//   agnz show   <id>
//
// Every verb prints a JSON object (or array) to stdout so the parent can
// parse the outcome from a Bash call. Errors print {"error": "..."} and exit 1.
//
// start/send/approve/answer normally spawn a detached runner (lib/runner.mjs)
// and return immediately; results reach the parent via the messages.jsonl hook.
// Pass --wait to run the segment inline and print its outcome instead.

import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createThreadManager } from "../lib/threads.mjs";
import { createRegistry } from "../lib/tools/registry.mjs";
import {
  loadAgentDef,
  parseAgentDefSource,
  validateAgentDef,
  buildToolPolicy,
} from "../lib/agent-defs.mjs";
import { createWorkspaceStore } from "../lib/workspace-store.mjs";
import { createSandbox } from "../lib/sandbox.mjs";
import { publish } from "../lib/event-bus.mjs";
import { runThread } from "../lib/loop.mjs";
import { resolveProfile, makeSandbox, PLUGIN_ROOT } from "../lib/orchestrate.mjs";

const RUNNER = resolve(PLUGIN_ROOT, "lib", "runner.mjs");

// ---- output helpers ----
function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}
function fail(message) {
  process.stdout.write(JSON.stringify({ error: message }) + "\n");
  process.exit(1);
}

// ---- minimal arg parser ----
// Value-flags always consume the next token (even one starting with "--",
// e.g. an --inline "---\n..." frontmatter block). Boolean flags never do.
const BOOLEAN_FLAGS = new Set(["wait", "persist", "all", "new"]);
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
      } else if (i + 1 < argv.length) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

// Resolve a target token to a thread: exact id first, else reuse the most
// recent live thread that goes by that name in this workspace (idle/stopped/
// running/awaiting — never an errored one). This is the reuse-by-name default.
async function resolveTarget(tm, cwd, token) {
  const byId = await tm.getThread(token);
  if (byId) return byId;
  const threads = await tm.listThreads();
  const candidates = threads
    .filter((t) => t.cwd === cwd && t.name === token && t.status !== "error")
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return candidates[0] || null;
}

function spawnRunner(payload) {
  const dir = mkdtempSync(join(tmpdir(), "agnz-run-"));
  const pf = join(dir, "payload.json");
  writeFileSync(pf, JSON.stringify(payload));
  const child = spawn(process.execPath, [RUNNER, pf], { detached: true, stdio: "ignore" });
  child.unref();
}

// Is a pid still a live process? Signal 0 probes without delivering anything.
// EPERM means it exists but we can't signal it (treat as alive); ESRCH = gone.
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Opportunistic stale-run recovery (there is no long-lived server in the CLI
// model). A thread left "running" whose runner process is gone — crashed or
// killed — is marked error so it stops looking live.
async function recoverIfStale(tm, thread) {
  if (thread && thread.status === "running" && !isAlive(thread.runnerPid)) {
    await tm
      .setStatus(thread.id, "error", {
        error: { message: "runner process is gone (crashed or killed) — recovered on inspection" },
        pending: null,
      })
      .catch(() => {});
    return { ...thread, status: "error" };
  }
  return thread;
}

// Run one segment inline (for --wait) and return a CLI-shaped outcome.
async function runInline(tm, registry, thread, payload) {
  const profile = await resolveProfile(thread);
  if (!profile) return { status: "error", error: "no LLM profile configured (run /agnz:setup add)" };
  const sandbox = makeSandbox(thread, registry);
  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  const outcome = await runThread({
    thread,
    threadMgr: tm,
    sandbox,
    registry,
    profile,
    pluginRoot: PLUGIN_ROOT,
    userMessage: payload.userMessage ?? null,
    resumeInput: payload.resumeInput ?? null,
    signal: controller.signal,
  });
  if (outcome.status === "awaiting_input") {
    const p = outcome.pending || {};
    return { status: "awaiting_input", kind: p.kind, tool_call_id: p.toolCallId, tool: p.name, question: p.question };
  }
  return { status: outcome.status, content: outcome.content, finish_reason: outcome.finishReason };
}

// ---- verbs ----
async function main() {
  const [verb, ...rest] = process.argv.slice(2);
  const { positionals, flags } = parseArgs(rest);
  const cwd = flags.cwd ? resolve(String(flags.cwd)) : process.env.AGNZ_CWD || process.cwd();
  const tm = createThreadManager();
  const registry = createRegistry();

  switch (verb) {
    case "start": {
      const name = positionals[0];
      const message = positionals[1] ?? (typeof flags.message === "string" ? flags.message : null);
      if (!name) fail("start: <name> is required");
      if (!flags.agent && !flags.inline) fail("start: --agent <def> or --inline <frontmatter> is required");
      if (flags.agent && flags.inline) fail("start: --agent and --inline are mutually exclusive");

      let agentDef;
      try {
        if (flags.agent) {
          agentDef = await loadAgentDef(cwd, String(flags.agent), PLUGIN_ROOT);
        } else {
          agentDef = parseAgentDefSource(String(flags.inline), "inline");
          if (!agentDef.name) agentDef.name = `inline-${Date.now()}`;
          validateAgentDef(agentDef, "inline"); // throws on invalid → caught below
        }
      } catch (err) {
        fail(err.message);
      }

      const thread = await tm.createThread({
        cwd,
        agentDef,
        name,
        // The founding purpose of the thread, used as a durable legibility
        // label (agnz list / the parent hook) long after the transcript has
        // scrolled away. Prefer an explicit --description; otherwise fall back
        // to the initial task so a thread always says what it was started for,
        // even if it never reaches a final answer.
        description:
          typeof flags.description === "string"
            ? flags.description
            : typeof message === "string"
              ? message.slice(0, 200)
              : null,
      });
      // Fail fast on a bad cwd / policy.
      createSandbox({ root: thread.cwd, policy: buildToolPolicy(agentDef, registry.list().map((t) => t.name)) });

      if (message == null) {
        out({ thread_id: thread.id, name, agent: agentDef.name, status: "idle" });
        return;
      }
      if (flags.wait) {
        out({ thread_id: thread.id, name, agent: agentDef.name, ...(await runInline(tm, registry, thread, { userMessage: message })) });
      } else {
        spawnRunner({ threadId: thread.id, userMessage: message });
        out({ thread_id: thread.id, name, agent: agentDef.name, status: "started" });
      }
      return;
    }

    case "send": {
      const target = positionals[0];
      const message = positionals[1] ?? (typeof flags.message === "string" ? flags.message : null);
      if (!target) fail("send: <name|id> is required");
      if (message == null) fail("send: a message is required");
      const thread = await resolveTarget(tm, cwd, target);
      if (!thread) fail(`no thread '${target}' (and no reusable agent by that name)`);
      if (thread.status === "error") {
        fail(`thread '${thread.id}' is in error state: ${thread.error?.message ?? "unknown"}. Start a fresh one.`);
      }
      if (thread.status === "running" || thread.status === "awaiting_input") {
        const agentName = thread.agentDef?.name || thread.name || `agent-${thread.id.slice(0, 8)}`;
        await publish(thread.cwd, { from: "parent", to: agentName, kind: "directive", text: message });
        out({ thread_id: thread.id, status: "queued", hint: `thread is ${thread.status}; message queued for the next turn boundary` });
        return;
      }
      if (flags.wait) {
        out({ thread_id: thread.id, ...(await runInline(tm, registry, thread, { userMessage: message })) });
      } else {
        spawnRunner({ threadId: thread.id, userMessage: message });
        out({ thread_id: thread.id, status: "started" });
      }
      return;
    }

    case "approve": {
      const id = positionals[0];
      const decision = positionals[1];
      if (!id) fail("approve: <id> is required");
      if (decision !== "allow" && decision !== "deny") fail("approve: decision must be 'allow' or 'deny'");
      const thread = await tm.getThread(id);
      if (!thread) fail(`no thread '${id}'`);
      if (thread.status !== "awaiting_input" || thread.pending?.kind !== "approval") {
        fail(`thread '${id}' is not awaiting approval (status=${thread.status}, pending=${thread.pending?.kind ?? "none"})`);
      }
      const resumeInput = { toolCallId: thread.pending.toolCallId, decision, persist: flags.persist === true };
      if (flags.wait) {
        out({ thread_id: id, ...(await runInline(tm, registry, thread, { resumeInput })) });
      } else {
        spawnRunner({ threadId: id, resumeInput });
        out({ thread_id: id, status: "started" });
      }
      return;
    }

    case "answer": {
      const id = positionals[0];
      const answer = positionals[1] ?? (typeof flags.message === "string" ? flags.message : null);
      if (!id) fail("answer: <id> is required");
      if (answer == null) fail("answer: an answer is required");
      const thread = await tm.getThread(id);
      if (!thread) fail(`no thread '${id}'`);
      if (thread.status !== "awaiting_input" || thread.pending?.kind !== "question") {
        fail(`thread '${id}' is not awaiting a question (status=${thread.status}, pending=${thread.pending?.kind ?? "none"})`);
      }
      const resumeInput = { toolCallId: thread.pending.toolCallId, answer };
      if (flags.wait) {
        out({ thread_id: id, ...(await runInline(tm, registry, thread, { resumeInput })) });
      } else {
        spawnRunner({ threadId: id, resumeInput });
        out({ thread_id: id, status: "started" });
      }
      return;
    }

    case "stop": {
      const id = positionals[0];
      if (!id) fail("stop: <id> is required");
      const thread = await tm.getThread(id);
      if (!thread) fail(`no thread '${id}'`);
      if (thread.runnerPid) {
        try {
          process.kill(thread.runnerPid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
      await tm.stopThread(id);
      out({ thread_id: id, status: "stopped" });
      return;
    }

    case "interrupt": {
      // Hard interrupt (amok brake / steer): optionally queue a directive,
      // then SIGUSR1 the runner so it aborts the current segment but stays
      // resumable. The directive drains on the next run.
      const id = positionals[0];
      const directive = positionals[1] ?? (typeof flags.message === "string" ? flags.message : null);
      if (!id) fail("interrupt: <id> is required");
      const thread = await tm.getThread(id);
      if (!thread) fail(`no thread '${id}'`);
      if (directive) {
        const agentName = thread.agentDef?.name || thread.name || `agent-${thread.id.slice(0, 8)}`;
        await publish(thread.cwd, { from: "parent", to: agentName, kind: "directive", text: directive });
      }
      let signalled = false;
      if (thread.runnerPid) {
        try {
          process.kill(thread.runnerPid, "SIGUSR1");
          signalled = true;
        } catch {
          /* runner already gone */
        }
      }
      out({ thread_id: id, status: "interrupted", signalled, directive_queued: !!directive });
      return;
    }

    case "list": {
      let threads = await tm.listThreads();
      if (!flags.all) threads = threads.filter((t) => t.cwd === cwd);
      threads = await Promise.all(threads.map((t) => recoverIfStale(tm, t)));
      if (typeof flags.status === "string") threads = threads.filter((t) => t.status === flags.status);
      out(
        threads.map((t) => ({
          thread_id: t.id,
          name: t.name,
          agent: t.agentDef?.name,
          status: t.status,
          summary:
            t.summary ||
            t.description ||
            (t.agentDef?.description ? t.agentDef.description.split("\n")[0].slice(0, 140) : null),
          updatedAt: t.updatedAt,
        })),
      );
      return;
    }

    case "show": {
      const id = positionals[0];
      if (!id) fail("show: <id> is required");
      let thread = await tm.getThread(id);
      if (!thread) fail(`no thread '${id}'`);
      thread = await recoverIfStale(tm, thread);
      const msgs = await tm.readMessages(id);
      out({
        thread: {
          thread_id: thread.id,
          name: thread.name,
          agent: thread.agentDef?.name,
          status: thread.status,
          summary: thread.summary || null,
          description: thread.description,
          cwd: thread.cwd,
          pending: thread.pending,
          error: thread.error,
        },
        recent: msgs.slice(-6),
      });
      return;
    }

    default:
      fail(`unknown verb '${verb ?? ""}'. Use: start | send | approve | answer | stop | interrupt | list | show`);
  }
}

main().catch((err) => fail(err.message));
