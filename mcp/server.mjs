#!/usr/bin/env node
// MCP server: exposes the agnz agent to Claude Code as a set of tools.
// Claude (the parent session) calls these tools to hold a conversation
// with a locally-hosted sub-agent that runs in its own sandbox.
//
// No npm dependencies — we implement the minimal JSON-RPC subset MCP
// needs in ./jsonrpc.mjs so the plugin ships zero node_modules.

import { runStdioServer, log } from "./jsonrpc.mjs";
import { createSandbox, Decision } from "../agent/sandbox.mjs";
import { createRegistry } from "../agent/tools/registry.mjs";
import { createMemoryStore } from "../agent/memory.mjs";
import { createThreadManager, ThreadStatus } from "../agent/threads.mjs";
import { createProfileStore } from "../agent/profiles.mjs";
import { runThread } from "../agent/loop.mjs";
import { resolveDataDir } from "../agent/data-dir.mjs";
import { kick, wait, forget } from "../agent/run-tracker.mjs";

// ---- data dir ----
//
// Versionsunabhängig: ~/.local/share/agnz (oder $XDG_DATA_HOME/agnz,
// oder $AGNZ_DATA_DIR override). Wichtig: jeder Plugin-Update legt einen
// neuen Cache-Ordner an, aber unsere Threads/Profiles/Memory bleiben
// wo sie sind. Siehe agent/data-dir.mjs für Details.

const DATA_DIR = resolveDataDir();

// ---- singletons (one per MCP server process) ----

const memory = createMemoryStore({ dataDir: DATA_DIR });
const threadMgr = createThreadManager();
const profileStore = createProfileStore({ dataDir: DATA_DIR });
const registry = createRegistry();

// Sandboxes are cached per-thread in memory; rebuilt from persisted
// thread.policy on first use after a server restart.
const sandboxes = new Map();
function sandboxFor(thread) {
  let sb = sandboxes.get(thread.id);
  if (!sb) {
    sb = createSandbox({ root: thread.cwd, policy: thread.policy || undefined });
    sandboxes.set(thread.id, sb);
  }
  return sb;
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

// ---- server-level instructions ----
//
// Surfaced to the parent model via the MCP `initialize` response. This is
// the ONE place where we get to frame the whole server — the tool
// descriptions can only speak about themselves. Keep it tight (<400 words),
// lead with the use case, explain the workflow, mention sandbox + memory.

const INSTRUCTIONS = `agnz exposes a sandboxed, locally-hosted LLM as a sub-agent you (the parent) can delegate work to. The sub-agent runs its own tool loop against a model you control (LM Studio, Ollama, any OpenAI-compatible endpoint) and only reports the final outcome back to you.

WHEN TO USE: delegate read-heavy or mechanically-repetitive file work — bulk reads, grep-and-summarize, find-and-replace across many files, code navigation — instead of doing it yourself. The sub-agent's intermediate tool calls don't count against your context window; only its final summary does. This is the same value model as your built-in Agent tool, but with a model the user hosts locally (free, private, no rate limits).

WHAT THE SUB-AGENT CAN DO: inside its sandbox it has list_dir, read_file, grep, edit_file, write_file, and ask_user. It is locked to a single cwd and cannot escape. edit_file and write_file are gated by default — the sub-agent will pause and require your approval via agent_approve before running them (set persist=true on the first approval to auto-allow for the rest of the thread).

TYPICAL WORKFLOW:
  1. agent_start(cwd) — create a thread locked to a directory. Returns thread_id.
  2. agent_send(thread_id, message) — give it a task; blocks until it finishes, pauses, or hits max_turns.
  3. If paused: use agent_approve (for tool-call approval pauses) or agent_answer (for ask_user question pauses). Check thread.pending.kind via agent_status to tell them apart.
  4. agent_stop when done (optional; transcripts persist).

CONCURRENCY: set detach=true on agent_send / agent_approve / agent_answer to run the sub-agent in the background, then agent_wait(thread_id) for the next event. Multiple sub-agents run in parallel freely — Node's event loop gives you real concurrency while they're waiting on their LLM endpoints.

MEMORY: agent_memory_read / agent_memory_write give you scoped persistent notes (thread, project, global) that survive across runs and plugin upgrades.`;

// ---- tool schemas ----
//
// Hand-written JSON Schemas — no zod needed. We keep them concise and
// rely on runtime validation inside handlers. Annotations (readOnlyHint
// etc.) are MCP 2025-03-26 hints — clients use them for UX like
// auto-approve of safe reads.

const tools = [
  {
    name: "agent_start",
    description:
      "Create a new conversation thread with the local agent. The agent will operate strictly inside `cwd` and use the given profile (or the active profile if omitted). Returns the thread id and initial policy.",
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
        cwd: { type: "string" },
        profile: { type: "string" },
        model: { type: "string" },
        policy: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["thread_id", "cwd", "profile", "model", "policy"],
    },
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Absolute path to the sandbox root for this thread." },
        profile: {
          type: "string",
          description: "Profile name (from /agnz:setup). Defaults to active profile.",
        },
        system_prompt: {
          type: "string",
          description: "Optional thread-level system prompt override.",
        },
      },
      required: ["cwd"],
    },
    async handler(args) {
      try {
        const profile = await profileStore.get(args.profile);
        if (!profile) {
          return errorResult(
            args.profile
              ? `no profile named '${args.profile}'. Run /agnz:setup add.`
              : "no active profile configured. Run /agnz:setup add.",
          );
        }
        const thread = await threadMgr.createThread({
          cwd: args.cwd,
          profile: profile.name,
          policy: profile.defaultPolicy,
          systemPrompt: args.system_prompt || null,
        });
        sandboxFor(thread); // fail fast on bad cwd
        log("info", { event: "thread_started", thread_id: thread.id, cwd: thread.cwd, profile: profile.name, model: profile.model }, "agnz.mcp");
        return jsonResult({
          thread_id: thread.id,
          cwd: thread.cwd,
          profile: profile.name,
          model: profile.model,
          policy: thread.policy,
        });
      } catch (err) {
        log("error", { event: "thread_start_failed", error: err.message }, "agnz.mcp");
        return errorResult(err.message);
      }
    },
  },

  {
    name: "agent_send",
    description:
      "Send a user message to a thread. Default mode (detach=false) blocks until the sub-agent finishes, pauses, or hits max_turns. With detach=true the sub-agent runs in the background and the call returns immediately with {status: 'started'} — use agent_wait to retrieve the outcome later. Detach mode lets you run multiple sub-agents concurrently or do other work while one is thinking.",
    annotations: {
      title: "Send message to agent",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        message: { type: "string", description: "The user message for the agent." },
        detach: {
          type: "boolean",
          description: "If true, return immediately and let the sub-agent run in the background. Default false.",
        },
      },
      required: ["thread_id", "message"],
    },
    async handler(args) {
      try {
        const thread = await threadMgr.getThread(args.thread_id);
        if (!thread) return errorResult(`no thread '${args.thread_id}'`);
        const profile = await profileStore.get(thread.profile);
        if (!profile) return errorResult(`profile '${thread.profile}' no longer exists`);
        const sandbox = sandboxFor(thread);

        const promise = kick(args.thread_id, () =>
          runThread({
            thread,
            threadMgr,
            sandbox,
            registry,
            memory,
            profile,
            userMessage: args.message,
          }),
        );

        if (args.detach === true) {
          return jsonResult({
            status: "started",
            thread_id: args.thread_id,
            hint: "Sub-agent is running in the background. Call agent_wait(thread_id) to block until next event, or agent_status for a non-blocking check.",
          });
        }

        const outcome = await promise;
        return formatOutcome(outcome, args.thread_id);
      } catch (err) {
        return errorResult(err.message);
      }
    },
  },

  {
    name: "agent_wait",
    description:
      "Block until a detached sub-agent reaches its next event (final response, pause, error). Use this after agent_send(detach=true) or agent_approve(detach=true). Optional timeout returns {status: 'still_running'} if nothing happens in time. Multiple concurrent waits on the same thread are safe.",
    annotations: {
      title: "Wait for agent event",
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        timeout_ms: {
          type: "number",
          description: "Optional timeout in milliseconds. If the sub-agent doesn't reach an event in this time, return {status: 'still_running'} without disturbing it.",
        },
      },
      required: ["thread_id"],
    },
    async handler(args) {
      try {
        const thread = await threadMgr.getThread(args.thread_id);
        if (!thread) return errorResult(`no thread '${args.thread_id}'`);

        const result = await wait(args.thread_id, args.timeout_ms);

        if (result === null) {
          // Nothing was tracked — return whatever the persisted state says.
          return jsonResult({
            status: "no_run_tracked",
            thread_id: args.thread_id,
            current_state: thread.status,
            hint: "No background run was tracked for this thread. Either nothing has been started since the MCP server restarted, or the run already completed and was cleared. Check agent_status for the persisted state.",
          });
        }
        if (result.timedOut) {
          const fresh = await threadMgr.getThread(args.thread_id);
          return jsonResult({
            status: "still_running",
            thread_id: args.thread_id,
            current_state: fresh.status,
            hint: "Sub-agent has not produced an event yet. Call agent_wait again to keep waiting.",
          });
        }
        return formatOutcome(result.outcome, args.thread_id);
      } catch (err) {
        return errorResult(err.message);
      }
    },
  },

  {
    name: "agent_approve",
    description:
      "Resolve a pending APPROVAL pause (sub-agent wants to run a tool that requires consent). Allow or deny the call. Set persist=true to apply the decision to all future calls of the same tool in this thread. Set detach=true to let the sub-agent continue in the background — use agent_wait afterwards. For ask_user pauses, use agent_answer instead.",
    annotations: {
      title: "Approve pending tool call",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        tool_call_id: { type: "string" },
        decision: { type: "string", enum: ["allow", "deny"] },
        persist: { type: "boolean" },
        detach: { type: "boolean" },
      },
      required: ["thread_id", "tool_call_id", "decision"],
    },
    async handler(args) {
      try {
        const { thread, profile, sandbox, error } = await loadPaused(args.thread_id, "approval");
        if (error) return error;

        const promise = kick(args.thread_id, () =>
          runThread({
            thread,
            threadMgr,
            sandbox,
            registry,
            memory,
            profile,
            userMessage: null,
            resumeInput: {
              toolCallId: args.tool_call_id,
              decision: args.decision === "allow" ? Decision.ALLOW : Decision.DENY,
              persist: args.persist === true,
            },
          }),
        );

        if (args.detach === true) {
          return jsonResult({
            status: "started",
            thread_id: args.thread_id,
            hint: "Sub-agent resumed in the background. Use agent_wait for the next event.",
          });
        }
        return formatOutcome(await promise, args.thread_id);
      } catch (err) {
        return errorResult(err.message);
      }
    },
  },

  {
    name: "agent_answer",
    description:
      "Resolve a pending QUESTION pause (sub-agent called ask_user and is waiting for clarification). Provide a free-text answer; the sub-agent will see it as the tool result and continue. Set detach=true to let the sub-agent continue in the background — use agent_wait afterwards.",
    annotations: {
      title: "Answer agent question",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        tool_call_id: { type: "string" },
        answer: { type: "string", description: "The answer to the sub-agent's question." },
        detach: { type: "boolean" },
      },
      required: ["thread_id", "tool_call_id", "answer"],
    },
    async handler(args) {
      try {
        const { thread, profile, sandbox, error } = await loadPaused(args.thread_id, "question");
        if (error) return error;

        const promise = kick(args.thread_id, () =>
          runThread({
            thread,
            threadMgr,
            sandbox,
            registry,
            memory,
            profile,
            userMessage: null,
            resumeInput: {
              toolCallId: args.tool_call_id,
              answer: args.answer,
            },
          }),
        );

        if (args.detach === true) {
          return jsonResult({
            status: "started",
            thread_id: args.thread_id,
            hint: "Sub-agent resumed in the background. Use agent_wait for the next event.",
          });
        }
        return formatOutcome(await promise, args.thread_id);
      } catch (err) {
        return errorResult(err.message);
      }
    },
  },

  {
    name: "agent_status",
    description: "Get the current status and meta of a thread.",
    annotations: {
      title: "Get thread status",
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: { thread_id: { type: "string" } },
      required: ["thread_id"],
    },
    async handler(args) {
      const thread = await threadMgr.getThread(args.thread_id);
      if (!thread) return errorResult(`no thread '${args.thread_id}'`);
      return jsonResult(thread);
    },
  },

  {
    name: "agent_list_threads",
    description: "List all known threads with their status.",
    annotations: {
      title: "List agent threads",
      readOnlyHint: true,
      openWorldHint: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        threads: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              cwd: { type: "string" },
              profile: { type: "string" },
              status: { type: "string" },
              createdAt: { type: "string" },
              updatedAt: { type: "string" },
            },
            required: ["id", "cwd", "profile", "status"],
          },
        },
      },
      required: ["threads"],
    },
    inputSchema: { type: "object", properties: {} },
    async handler() {
      const threads = await threadMgr.listThreads();
      return jsonResult({
        threads: threads.map((t) => ({
          id: t.id,
          cwd: t.cwd,
          profile: t.profile,
          status: t.status,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        })),
      });
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
      forget(args.thread_id);
      return textResult(`thread ${args.thread_id} stopped`);
    },
  },

  {
    name: "agent_memory_read",
    description:
      "Read from the agent's persistent memory. Scope 'thread' needs a thread_id key, scope 'project' needs a project path key, scope 'global' ignores key.",
    annotations: {
      title: "Read agent memory",
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["thread", "project", "global"] },
        key: {
          type: "string",
          description: "thread id for thread scope, project path for project scope, ignored for global",
        },
      },
      required: ["scope"],
    },
    async handler(args) {
      try {
        const content = await memory.read(args.scope, args.key);
        return textResult(content || "(empty)");
      } catch (err) {
        return errorResult(err.message);
      }
    },
  },

  {
    name: "agent_memory_write",
    description:
      "Write to the agent's persistent memory (project or global scope only). Overwrites existing content.",
    annotations: {
      title: "Write agent memory",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["project", "global"] },
        key: {
          type: "string",
          description: "project path for project scope, ignored for global",
        },
        content: { type: "string" },
      },
      required: ["scope", "content"],
    },
    async handler(args) {
      try {
        await memory.write(args.scope, args.key, args.content);
        return textResult("ok");
      } catch (err) {
        return errorResult(err.message);
      }
    },
  },

  {
    name: "agent_profiles_list",
    description: "List all configured profiles and the currently active one.",
    annotations: {
      title: "List agent profiles",
      readOnlyHint: true,
      openWorldHint: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        active: { type: ["string", "null"] },
        profiles: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              baseUrl: { type: "string" },
              model: { type: "string" },
            },
            required: ["name", "baseUrl", "model"],
          },
        },
      },
      required: ["active", "profiles"],
    },
    inputSchema: { type: "object", properties: {} },
    async handler() {
      const summary = await profileStore.list();
      return jsonResult(summary);
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
            ? "Use agent_approve."
            : actualKind === "question"
              ? "Use agent_answer."
              : ""),
      ),
    };
  }
  const profile = await profileStore.get(thread.profile);
  if (!profile) return { error: errorResult(`profile '${thread.profile}' no longer exists`) };
  const sandbox = sandboxFor(thread);
  return { thread, profile, sandbox };
}

// Strip bulky string fields from approval args so write_file contents
// and edit_file hunks don't blow up Parent Claude's context on every
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
          "Sub-agent is asking a clarifying question. Reply with agent_answer(thread_id, tool_call_id, answer).",
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
        "Sub-agent wants to run a tool that needs consent. Reply with agent_approve(thread_id, tool_call_id, decision=allow|deny, persist?). Long string fields in `args` (file contents, diff hunks) are truncated to a length-annotated preview — the full args stay on disk in the thread meta.",
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
    // Don't fail boot just because recovery had a hiccup; log to stderr
    // (which CC captures into plugin logs).
    process.stderr.write(`agnz: recovery scan failed: ${err.message}\n`);
  }
}

// ---- boot -----------------------------------------------------------------

await recoverStaleRuns();
await runStdioServer({ name: "agnz", version: "0.3.0", instructions: INSTRUCTIONS, tools });
