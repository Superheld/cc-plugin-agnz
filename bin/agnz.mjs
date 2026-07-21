#!/usr/bin/env node
// agnz CLI — the parent's interface to the local-model sub-agent (replaces
// the old MCP tool surface). Verbs:
//
//   agnz start  <name> ["task"] --agent <def> | --inline "<frontmatter>"
//                              [--cwd .] [--description "..."]
//   agnz send   <name|id> "message"
//   agnz approve <id> allow|deny      [--persist]
//   agnz answer <id> "answer text"
//   agnz wait   <id|name>             [--timeout <s>]
//   agnz stop   <id>                  (archive: hide from list, keep transcript)
//   agnz list   [--status <s>] [--all]
//   agnz show   <id>
//
// Every verb prints a JSON object (or array) to stdout so the parent can
// parse the outcome from a Bash call. Errors print {"error": "..."} and exit 1.
//
// Runs are ALWAYS detached (ADR 0015): start/send/approve/answer spawn a
// detached runner (lib/runner.mjs) and return {status:"started"}; results
// reach the parent via the messages.jsonl hook, or by collecting them with
// `agnz wait <id>` — a watcher that polls the thread meta until the run
// leaves "running". The old inline `--wait` flag is gone (it serialized the
// multi-process model and a Bash-tool timeout could kill a run mid-segment);
// the eval harness keeps its own synchronous path via runThread directly.

import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createThreadManager } from "../lib/threads.mjs";
import { createRegistry } from "../lib/tools/registry.mjs";
import {
  loadAgentDef,
  parseAgentDefSource,
  validateAgentDef,
  buildToolPolicy,
} from "../lib/agent-defs.mjs";
import { createSandbox } from "../lib/sandbox.mjs";
import { publish } from "../lib/event-bus.mjs";
import { readTrace, aggregateTrace } from "../lib/trace-stats.mjs";
import { PLUGIN_ROOT } from "../lib/orchestrate.mjs";

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
  // Self-heal the workspace first: re-register any on-disk thread missing from
  // the index, so a ghost is resolvable by id or name (otherwise send <name>
  // would spawn a duplicate instead of resuming the existing thread).
  const threads = await tm.reconcileWorkspace(cwd);
  const byId = threads.find((t) => t.id === token) || (await tm.getThread(token));
  if (byId) return byId;
  const candidates = threads
    .filter((t) => t.name === token && t.status !== "error")
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

// ---- wait: decide the collected outcome from a thread's meta + transcript ----
// Pure so it is unit-testable without a runner. `messages` is the transcript
// (only read by the caller when the thread has finished — idle). When the
// thread is idle we surface `content`: the last assistant message's text, i.e.
// the distilled final answer — full, uncapped, because it is the designed
// payload the lead is waiting to collect.
export function decideWaitOutcome(thread, messages) {
  const outcome = {
    thread_id: thread.id,
    status: thread.status,
    summary: thread.summary || null,
    pending: thread.pending || null,
  };
  // Surface the crash reason on an error thread — a waiter on a dead run wants
  // to know why (a small, structured field; the transcript stays unread).
  if (thread.error) outcome.error = thread.error;
  if (thread.status === "idle" && Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && typeof m.content === "string" && m.content) {
        outcome.content = m.content;
        break;
      }
    }
  }
  return outcome;
}

// ---- show: a token-lean structural view (ADR 0015 §2) ----
// A status check must never forward a full tool result into the lead's
// context, so each recent message's content is capped with an elision marker
// that reports the original size.
const RECENT_CONTENT_CAP = 500;

function capContent(content) {
  if (typeof content !== "string" || content.length <= RECENT_CONTENT_CAP) return content;
  const kb = (content.length / 1024).toFixed(1);
  return `${content.slice(0, RECENT_CONTENT_CAP)}…[elided, ${kb} KB total]`;
}

// Cap a transcript message's content field, preserving every other field
// (role, tool_call_id, tool_calls, ts). Assistant messages that carry only
// tool_calls (null content) pass through untouched.
function capMessageContent(m) {
  if (!m || typeof m !== "object") return m;
  return typeof m.content === "string" ? { ...m, content: capContent(m.content) } : m;
}

// Reduce an agentDef to its policy-relevant identity — name, the first line of
// its description, and its tool allow/deny lists. The heavy body (system-prompt
// text) is dropped: the lead asks "show" for state, not for the prompt.
function reduceAgentDef(agentDef) {
  if (!agentDef) return null;
  return {
    name: agentDef.name || null,
    description: agentDef.description ? String(agentDef.description).split("\n")[0] : null,
    tools: agentDef.tools || null,
    disallowedTools: agentDef.disallowedTools || null,
  };
}

// Compact the trace fold to the fields a lead reads at a glance. Drops the
// per-event detail; keeps turns, tokens, latency, tool outcomes, repair rate.
function compactStats(s) {
  return {
    turns: s.turns,
    llmCalls: s.llmCalls,
    tokens: s.tokens,
    avgLlmLatencyMs: s.avgLlmLatencyMs,
    durationMs: s.durationMs,
    toolCalls: s.toolCalls,
    repairs: s.repairs,
    terminalReason: s.terminalReason,
  };
}

// Build the `show` view. Pure: the caller does the IO (readMessages, readTrace)
// and passes the results in, so this is directly unit-testable. `stats` is the
// compacted trace fold or null when the thread has no trace file yet.
export function buildShowView(thread, messages, stats) {
  const view = {
    thread: {
      thread_id: thread.id,
      name: thread.name,
      agent: thread.agentDef?.name,
      agentDef: reduceAgentDef(thread.agentDef),
      status: thread.status,
      summary: thread.summary || null,
      description: thread.description,
      cwd: thread.cwd,
      pending: thread.pending,
      error: thread.error,
    },
    recent: (messages || []).slice(-6).map(capMessageContent),
  };
  if (thread.card) view.thread.card = thread.card;
  if (stats) view.stats = stats;
  return view;
}

// ---- verbs ----
async function main() {
  const [verb, ...rest] = process.argv.slice(2);
  const { positionals, flags } = parseArgs(rest);
  const cwd = flags.cwd ? resolve(String(flags.cwd)) : process.env.AGNZ_CWD || process.cwd();
  const tm = createThreadManager();
  const registry = createRegistry();

  // --wait is gone (ADR 0015): runs are always detached. Fail loudly with a
  // pointer rather than silently ignoring the flag, so a stale caller learns
  // the new collect verb.
  if (flags.wait && ["start", "send", "approve", "answer"].includes(verb)) {
    fail(
      "--wait was removed (ADR 0015): runs are always detached — use 'agnz wait <id> [--timeout <s>]' to collect the outcome",
    );
  }

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
      spawnRunner({ threadId: thread.id, userMessage: message });
      out({ thread_id: thread.id, name, agent: agentDef.name, status: "started" });
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
      spawnRunner({ threadId: thread.id, userMessage: message });
      out({ thread_id: thread.id, status: "started" });
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
      spawnRunner({ threadId: id, resumeInput });
      out({ thread_id: id, status: "started" });
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
      spawnRunner({ threadId: id, resumeInput });
      out({ thread_id: id, status: "started" });
      return;
    }

    case "wait": {
      // Watcher, not worker (ADR 0015): poll the thread meta with backoff until
      // the run leaves "running", then print the collected outcome. On timeout
      // only THIS call dies — the detached runner keeps going, so the lead can
      // wait again or let the message hook deliver the result passively. Doubles
      // as "collect": called on an already-finished thread it returns at once.
      const target = positionals[0];
      if (!target) fail("wait: <id|name> is required");
      const timeoutS = flags.timeout != null ? Number(flags.timeout) : 300;
      if (!Number.isFinite(timeoutS) || timeoutS < 0) fail("wait: --timeout must be a non-negative number of seconds");
      let thread = await resolveTarget(tm, cwd, target);
      if (!thread) fail(`no thread '${target}' (and no reusable agent by that name)`);

      const deadline = Date.now() + timeoutS * 1000;
      let delay = 250; // ms, backs off to a 2s cap — no busy-loop
      for (;;) {
        thread = await recoverIfStale(tm, await tm.getThread(thread.id));
        if (!thread) fail(`thread '${target}' disappeared while waiting`);
        if (thread.status !== "running") {
          const msgs = thread.status === "idle" ? await tm.readMessages(thread.id) : null;
          out(decideWaitOutcome(thread, msgs));
          return;
        }
        if (Date.now() >= deadline) {
          out({
            thread_id: thread.id,
            status: "running",
            timeout: true,
            note: "still running — wait again or rely on the message hook",
          });
          return;
        }
        await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
        delay = Math.min(delay * 2, 2000);
      }
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
      // `stop` archives, it does not delete: the transcript stays on disk and
      // the thread drops out of the workspace list. Say so, so the lead learns
      // it can safely close finished threads to keep the list legible.
      out({
        thread_id: id,
        status: "stopped",
        note: "archived — transcript kept; resume with 'agnz send'",
      });
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
      // Default: reconcile the current workspace directly — its threads/ dir is
      // the source of truth, so a ghost (meta on disk, index entry lost) still
      // appears and gets re-registered. --all uses the index-driven scan, which
      // self-heals every workspace the index knows about.
      let threads = flags.all ? await tm.listThreads() : await tm.reconcileWorkspace(cwd);
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
      // Surface the trace fold when the thread has a trace file — makes `show`
      // the one-call structural view (state + spend), so the lead never reaches
      // for the raw transcript. readTrace returns [] when there is no trace yet.
      const entries = await readTrace(thread.cwd, thread.id);
      const stats = entries.length ? compactStats(aggregateTrace(entries)) : null;
      out(buildShowView(thread, msgs, stats));
      return;
    }

    default:
      fail(`unknown verb '${verb ?? ""}'. Use: start | send | approve | answer | wait | stop | interrupt | list | show`);
  }
}

// Only drive the CLI when run as the entrypoint — importing this module (the
// tests exercise decideWaitOutcome / buildShowView directly) must not run main.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => fail(err.message));
}
