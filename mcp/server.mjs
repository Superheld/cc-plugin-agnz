#!/usr/bin/env node
// MCP server: exposes the agnz agent to Claude Code as a set of tools.
// Claude (the parent session) calls these tools to hold a conversation
// with a locally-hosted sub-agent that runs in its own sandbox.
//
// No npm dependencies — we implement the minimal JSON-RPC subset MCP
// needs in ./jsonrpc.mjs so the plugin ships zero node_modules.

import { runStdioServer, log } from "./jsonrpc.mjs";
import { createSandbox, Decision } from "../lib/sandbox.mjs";
import { createRegistry } from "../lib/tools/registry.mjs";
import { createThreadManager, ThreadStatus } from "../lib/threads.mjs";
import { createProfileStore } from "../lib/profiles.mjs";
import { runThread } from "../lib/loop.mjs";
import { resolveUserDir } from "../lib/data-dir.mjs";
import { loadAgentDef, listAgentDefs, buildToolPolicy, parseAgentDefSource, validateAgentDef } from "../lib/agent-defs.mjs";
import { kick, forget } from "../lib/run-tracker.mjs";
import { createWorkspaceStore } from "../lib/workspace-store.mjs";
import { publish } from "../lib/event-bus.mjs";
import { INSTRUCTIONS } from "../lib/prompts.mjs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

// Plugin root: one level up from mcp/server.mjs. Passed to loadAgentDef so
// agents bundled in agents/ are discoverable regardless of the user's cwd.
const PLUGIN_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");


// ---- data dirs ----
//
// ADR 0001: two roots. userDir holds profiles (and, in the future,
// any user-wide settings). Per-project workspace state lives under
// <cwd>/.claude/agnz/ and is owned by workspace-store.mjs — this
// server doesn't touch it directly; threads.mjs routes through it.

const USER_DIR = resolveUserDir();

// ---- singletons (one per MCP server process) ----

const threadMgr = createThreadManager();
const profileStore = createProfileStore({ dataDir: USER_DIR });
const registry = createRegistry();

// Sandboxes are cached per-thread in memory; rebuilt from agentDef on first
// use after a server restart (policy is not stored in thread meta).
const sandboxes = new Map();

// One AbortController per thread so agent_stop can cancel an in-flight run.
const abortControllers = new Map();

// Start or replace an in-flight run for a thread, wiring a fresh AbortSignal.
function kickWithAbort(threadId, runFn) {
  abortControllers.get(threadId)?.abort();
  const controller = new AbortController();
  abortControllers.set(threadId, controller);
  return kick(threadId, () => runFn(controller.signal));
}

function sandboxFor(thread) {
  let sb = sandboxes.get(thread.id);
  if (!sb) {
    const availableTools = registry.list().map(t => t.name);
    const policy = thread.agentDef ? buildToolPolicy(thread.agentDef, availableTools) : {};
    sb = createSandbox({ root: thread.cwd, policy });
    sandboxes.set(thread.id, sb);
  }
  return sb;
}

// Resolve the LLM profile for a thread at call time. Profile is not stored in
// thread meta — it is always re-derived from agentDef.model via workspace
// mappings so profile changes take effect without restarting the thread.
async function resolveProfile(thread) {
  const store = createWorkspaceStore(thread.cwd);
  const modelIdentifier = thread.agentDef?.model || "_default";
  const profileName = await store.resolveModelToProfile(modelIdentifier);
  return profileStore.get(profileName);
}

// ---- result helpers ----
//
// jsonResult returns BOTH `content` (text fallback for old clients) and
// `structuredContent` (parseable JSON for MCP 2025-06-18 clients). If the
// payload is naturally an array or scalar, wrap it in `{ value: ... }`
// because the spec requires structuredContent to be an object.

function textResult(text) {
  return { content: [{ type: "text", text }] };
}
function jsonResult(obj) {
  const structured = obj && typeof obj === "object" && !Array.isArray(obj) ? obj : { value: obj };
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
    structuredContent: structured,
  };
}
function errorResult(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

// INSTRUCTIONS is imported from ../lib/prompts.mjs

// ---- tool schemas ----
//
// Hand-written JSON Schemas — no zod needed. We keep them concise and
// rely on runtime validation inside handlers. Annotations (readOnlyHint
// etc.) are MCP 2025-03-26 hints — clients use them for UX like
// auto-approve of safe reads.

// Shared outcome schema for every tool that goes through formatOutcome().
// The shape is a discriminated union on `status` — thread_send /
// thread_approve / thread_answer all use this. Rather than encoding
// the union as oneOf (which MCP 2025-06-18 clients do validate), we
// list all possible fields as optional and leave status as the
// discriminator. This matches what the handlers actually emit.
const OUTCOME_SCHEMA = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: [
        "final",
        "awaiting_input",
        "started",
        "still_running",
        "max_turns",
        "no_run_tracked",
        "stopped",
        "unknown",
      ],
      description: "Discriminator for the outcome shape.",
    },
    thread_id: { type: "string" },
    // `final`
    content: { type: "string", description: "Final assistant content (status=final)." },
    finish_reason: { type: "string" },
    // `awaiting_input`
    kind: {
      type: "string",
      enum: ["approval", "question"],
      description: "Pause kind (status=awaiting_input).",
    },
    tool_call_id: { type: "string" },
    tool: { type: "string", description: "Tool name awaiting approval (kind=approval)." },
    args: { type: "object", description: "Tool args preview (kind=approval; long strings truncated)." },
    question: { type: "string", description: "Clarifying question (kind=question)." },
    options: { type: "array" },
    context: {},
    // `still_running` / `no_run_tracked`
    current_state: { type: "string" },
    // `max_turns` / `unknown`
    note: { type: "string" },
    outcome: {},
    // generic
    hint: { type: "string" },
  },
  required: ["status", "thread_id"],
};

const tools = [
  {
    name: "agent_start",
    description:
      "Start a sub-agent thread. Pass `agent` (name of a definition file at ~/.claude/agents/ or <cwd>/.claude/agents/) OR `inline` (a raw frontmatter markdown string) to define the agent. One of the two is required. Optionally pass `name` to label the thread.",
    annotations: {
      title: "Start agent thread",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        name: { type: ["string", "null"] },
        agent: { type: "string" },
      },
      required: ["thread_id", "agent"],
    },
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Human-readable name for this agent instance. Used as the message routing address — must be unique among active agents in the workspace.",
        },
        description: {
          type: "string",
          description: "Optional short description of what this thread is working on. Shown in workspace summaries so the parent knows what each agent is doing.",
        },
        agent: {
          type: "string",
          description: "Agent definition name (from ~/.claude/agents/ or <cwd>/.claude/agents/). Mutually exclusive with `inline`.",
        },
        inline: {
          type: "string",
          description: "Raw frontmatter markdown string defining an ad-hoc agent. Same format as an agent definition file. Mutually exclusive with `agent`.",
        },
      },
      required: ["name"],
    },
    async handler(args) {
      try {
        // cwd comes from the workspace this MCP server is serving.
        // In practice Claude Code sets CWD when invoking the MCP server,
        // or we fall back to reading the workspace from an environment variable.
        const cwd = process.env.AGNZ_CWD || process.cwd();

        let agentDef = null;
        let profileName = args.profile;

        if (!args.agent && !args.inline) {
          return errorResult("either `agent` (name) or `inline` (frontmatter string) is required");
        }
        if (args.agent && args.inline) {
          return errorResult("`agent` and `inline` are mutually exclusive");
        }

        try {
          if (args.agent) {
            agentDef = await loadAgentDef(cwd, args.agent, PLUGIN_ROOT);
          } else {
            const parsed = parseAgentDefSource(args.inline);
            // synthesise a name if the inline def omits it
            if (!parsed.name) parsed.name = `inline-${Date.now()}`;
            const errs = validateAgentDef(parsed);
            if (errs.length > 0) return errorResult(`invalid inline agent def: ${errs.join(", ")}`);
            agentDef = parsed;
          }
        } catch (err) {
          return errorResult(err.message);
        }

        // Map model identifier from agent def to profile name via workspace mappings.
        // Resolution: mappings[model] → mappings["_default"] → model string as profile name.
        // NOTE: activeProfile in profiles.json is NOT consulted here — it is a UI-only
        // convenience for setup commands. Profile routing is fully controlled by
        // workspace.json → modelProfileMappings.
        const store = createWorkspaceStore(cwd);
        const modelIdentifier = agentDef.model || "_default";
        profileName = await store.resolveModelToProfile(modelIdentifier);

        const profile = await profileStore.get(profileName);
        if (!profile) {
          return errorResult(
            `no profile named '${profileName}'. Run /agnz:setup add.`,
          );
        }

        // Policy comes from the agent def frontmatter only:
        // tools (whitelist) → allow, disallowedTools → deny, else → ask.
        // Skill is auto-allowed if the def has skills configured.
        const availableTools = registry.list().map(t => t.name);
        const policy = buildToolPolicy(agentDef, availableTools);

        const thread = await threadMgr.createThread({
          cwd,
          agentDef,
          name: args.name,
          description: args.description || null,
        });
        sandboxFor(thread); // fail fast on bad cwd
        log("info", { event: "thread_started", thread_id: thread.id, cwd: thread.cwd, profile: profile.name, model: profile.model, agent: agentDef.name }, "agnz.mcp");
        return jsonResult({
          thread_id: thread.id,
          name: args.name || null,
          agent: agentDef.name,
        });
      } catch (err) {
        log("error", { event: "thread_start_failed", error: err.message }, "agnz.mcp");
        return errorResult(err.message);
      }
    },
  },

  {
    name: "thread_send",
    description:
      "Send a message to a thread. Returns immediately — the agent runs in the background. If the thread is idle or stopped, this starts a new run. If the thread is running or paused, the message is queued to the mailbox and delivered at the next turn boundary. Blocked on error-status threads — use agent_start to create a fresh thread instead.",
    annotations: {
      title: "Send message to thread",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    outputSchema: OUTCOME_SCHEMA,
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        message: { type: "string", description: "The message for the agent." },
      },
      required: ["thread_id", "message"],
    },
    async handler(args) {
      try {
        const thread = await threadMgr.getThread(args.thread_id);
        if (!thread) return errorResult(`no thread '${args.thread_id}'`);

        if (thread.status === ThreadStatus.ERROR) {
          return errorResult(
            `thread '${args.thread_id}' is in error state: ${thread.error?.message ?? "unknown error"}. ` +
            `Use agent_start to create a fresh thread.`,
          );
        }

        // Active thread: route through mailbox so the loop drains it at the
        // next turn boundary. Avoids role-alternation errors on strict models.
        if (thread.status === ThreadStatus.RUNNING || thread.status === ThreadStatus.AWAITING_INPUT) {
          const agentName = thread.agentDef?.name || thread.agentName || `agent-${thread.id.slice(0, 8)}`;
          await publish(thread.cwd, {
            from: "parent",
            to: agentName,
            kind: "directive",
            text: args.message,
          });
          return jsonResult({
            status: "queued",
            thread_id: args.thread_id,
            hint: `Thread is ${thread.status} — message queued and will be delivered at the next turn boundary.`,
          });
        }

        // idle or stopped: start a new run (stopped transcript is preserved).
        const profile = await resolveProfile(thread);
        if (!profile) return errorResult(`no profile found for thread '${args.thread_id}'. Run /agnz:setup add.`);
        const sandbox = sandboxFor(thread);

        kickWithAbort(args.thread_id, (signal) =>
          runThread({
            thread,
            threadMgr,
            sandbox,
            registry,
            profile,
            pluginRoot: PLUGIN_ROOT,
            userMessage: args.message,
            signal,
          }),
        );

        return jsonResult({
          status: "started",
          thread_id: args.thread_id,
          hint: "Agent running in the background. Results arrive via the UserPromptSubmit hook at your next prompt. Non-blocking status check: read <cwd>/.claude/agnz/threads/<thread_id>.meta.json.",
        });
      } catch (err) {
        return errorResult(err.message);
      }
    },
  },

  {
    name: "thread_approve",
    description:
      "Resolve a pending APPROVAL pause — the agent wants to run a tool that requires consent. Allow or deny the call. Set persist=true to silently allow all future calls of the same tool in this thread. The agent resumes in the background. For AskUser question pauses, use thread_answer instead.",
    annotations: {
      title: "Approve pending tool call",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    outputSchema: OUTCOME_SCHEMA,
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        tool_call_id: { type: "string" },
        decision: { type: "string", enum: ["allow", "deny"] },
        persist: { type: "boolean", description: "If true, remember this decision for all future calls of the same tool in this thread." },
      },
      required: ["thread_id", "tool_call_id", "decision"],
    },
    async handler(args) {
      try {
        const { thread, profile, sandbox, error } = await loadPaused(args.thread_id, "approval");
        if (error) return error;

        kickWithAbort(args.thread_id, (signal) =>
          runThread({
            thread,
            threadMgr,
            sandbox,
            registry,
            profile,
            pluginRoot: PLUGIN_ROOT,
            userMessage: null,
            resumeInput: {
              toolCallId: args.tool_call_id,
              decision: args.decision === "allow" ? Decision.ALLOW : Decision.DENY,
              persist: args.persist === true,
            },
            signal,
          }),
        );

        return jsonResult({
          status: "started",
          thread_id: args.thread_id,
          hint: "Agent resumed in the background. Results arrive via the hook at your next prompt.",
        });
      } catch (err) {
        return errorResult(err.message);
      }
    },
  },

  {
    name: "thread_answer",
    description:
      "Resolve a pending QUESTION pause — the agent called AskUser and is waiting for clarification. Provide a free-text answer; the agent sees it as the tool result and resumes in the background. For tool approval pauses, use thread_approve instead.",
    annotations: {
      title: "Answer agent question",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    outputSchema: OUTCOME_SCHEMA,
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        tool_call_id: { type: "string" },
        answer: { type: "string", description: "The answer to the agent's question." },
      },
      required: ["thread_id", "tool_call_id", "answer"],
    },
    async handler(args) {
      try {
        const { thread, profile, sandbox, error } = await loadPaused(args.thread_id, "question");
        if (error) return error;

        kickWithAbort(args.thread_id, (signal) =>
          runThread({
            thread,
            threadMgr,
            sandbox,
            registry,
            profile,
            pluginRoot: PLUGIN_ROOT,
            userMessage: null,
            resumeInput: {
              toolCallId: args.tool_call_id,
              answer: args.answer,
            },
            signal,
          }),
        );

        return jsonResult({
          status: "started",
          thread_id: args.thread_id,
          hint: "Agent resumed in the background. Results arrive via the hook at your next prompt.",
        });
      } catch (err) {
        return errorResult(err.message);
      }
    },
  },

  {
    name: "agent_stop",
    description:
      "Mark a thread as stopped. In-memory sandbox state is dropped; persisted transcript is kept.",
    annotations: {
      title: "Stop agent thread",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        status: { type: "string", enum: ["stopped"] },
      },
      required: ["thread_id", "status"],
    },
    inputSchema: {
      type: "object",
      properties: { thread_id: { type: "string" } },
      required: ["thread_id"],
    },
    async handler(args) {
      const thread = await threadMgr.getThread(args.thread_id);
      if (!thread) return errorResult(`no thread '${args.thread_id}'`);
      await threadMgr.stopThread(args.thread_id);
      sandboxes.delete(args.thread_id);
      abortControllers.get(args.thread_id)?.abort();
      abortControllers.delete(args.thread_id);
      forget(args.thread_id);
      return jsonResult({
        thread_id: args.thread_id,
        status: "stopped",
      });
    },
  },

];

/**
 * Load a paused thread and validate it's awaiting the right kind of input.
 * Returns either { thread, profile, sandbox } on success or { error } with
 * a ready-to-return MCP error result.
 */
async function loadPaused(threadId, expectedKind) {
  const thread = await threadMgr.getThread(threadId);
  if (!thread) return { error: errorResult(`no thread '${threadId}'`) };
  if (thread.status !== "awaiting_input") {
    return {
      error: errorResult(`thread is not awaiting input (status=${thread.status})`),
    };
  }
  const actualKind = thread.pending?.kind;
  if (actualKind !== expectedKind) {
    return {
      error: errorResult(
        `thread is awaiting ${actualKind || "unknown"}, not ${expectedKind}. ` +
          (actualKind === "approval"
            ? "Use thread_approve."
            : actualKind === "question"
              ? "Use thread_answer."
              : ""),
      ),
    };
  }
  const profile = await resolveProfile(thread);
  if (!profile) return { error: errorResult(`no profile found for thread '${threadId}'. Run /agnz:setup add.`) };
  const sandbox = sandboxFor(thread);
  return { thread, profile, sandbox };
}

// Strip bulky string fields from approval args so Write contents
// and Edit hunks don't blow up Parent Claude's context on every
// pause. Short strings pass through untouched; long ones get replaced
// with a sentinel that shows total length and a short head preview,
// enough to decide allow/deny without transferring the whole payload.
// The full args remain on disk in the thread meta if deeper inspection
// is needed.
const APPROVAL_ARG_PREVIEW_LIMIT = 300;
function previewArgs(args) {
  if (!args || typeof args !== "object") return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && v.length > APPROVAL_ARG_PREVIEW_LIMIT) {
      const head = v.slice(0, 120).replace(/\n/g, "\\n");
      out[k] = `<string: ${v.length} chars, head: "${head}…">`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function formatOutcome(outcome, threadId) {
  if (outcome.status === "final") {
    log("info", { event: "thread_final", thread_id: threadId, finish_reason: outcome.finishReason, content_length: outcome.content?.length ?? 0 }, "agnz.mcp");
    return jsonResult({
      status: "final",
      thread_id: threadId,
      content: outcome.content,
      finish_reason: outcome.finishReason,
    });
  }
  if (outcome.status === "awaiting_input") {
    const p = outcome.pending;
    if (p?.kind === "question") {
      log("info", { event: "thread_paused", thread_id: threadId, kind: "question", tool_call_id: p.toolCallId }, "agnz.mcp");
      return jsonResult({
        status: "awaiting_input",
        kind: "question",
        thread_id: threadId,
        tool_call_id: p.toolCallId,
        question: p.question,
        options: p.options || undefined,
        context: p.context || undefined,
        hint:
          "Agent is asking a clarifying question. Reply with thread_answer(thread_id, tool_call_id, answer).",
      });
    }
    // approval (default)
    log("info", { event: "thread_paused", thread_id: threadId, kind: "approval", tool: p.name, tool_call_id: p.toolCallId }, "agnz.mcp");
    return jsonResult({
      status: "awaiting_input",
      kind: "approval",
      thread_id: threadId,
      tool_call_id: p.toolCallId,
      tool: p.name,
      args: previewArgs(p.args),
      hint:
        "Agent wants to run a tool that needs consent. Reply with thread_approve(thread_id, tool_call_id, decision=allow|deny, persist?). Long string fields in `args` (file contents, diff hunks) are truncated to a length-annotated preview — the full args stay on disk in the thread meta.",
    });
  }
  if (outcome.status === "max_turns") {
    log("warning", { event: "thread_max_turns", thread_id: threadId }, "agnz.mcp");
    return jsonResult({ status: "max_turns", thread_id: threadId, note: outcome.content });
  }
  log("warning", { event: "thread_unknown_outcome", thread_id: threadId, status: outcome.status }, "agnz.mcp");
  return jsonResult({ status: "unknown", thread_id: threadId, outcome });
}

// ---- startup recovery -----------------------------------------------------
//
// If the MCP server crashed (or was killed) during a run, threads can be
// left in status="running" with no in-flight promise to recover them. On
// boot we scan for those and mark them as errored so the user notices.
// awaiting_input threads are fine — they're paused on disk, ready to resume.

async function recoverStaleRuns() {
  try {
    const threads = await threadMgr.listThreads();
    let recovered = 0;
    for (const t of threads) {
      if (t.status === ThreadStatus.RUNNING) {
        await threadMgr.setStatus(t.id, ThreadStatus.ERROR, {
          error: {
            message: "Thread was running when the MCP server stopped — marked as error on restart.",
          },
          pending: null,
        });
        recovered++;
      }
    }
    if (recovered > 0) {
      log("notice", { event: "stale_runs_recovered", count: recovered }, "agnz.mcp");
    }
  } catch (err) {
    process.stderr.write(`agnz: recovery scan failed: ${err.message}\n`);
  }
}

// ---- boot -----------------------------------------------------------------

await recoverStaleRuns();
await runStdioServer({ name: "agnz", version: "0.11.9", instructions: INSTRUCTIONS, tools });
