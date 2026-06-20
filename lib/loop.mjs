// Agent loop: the heart of the plugin. Drives an LLM ↔ tool conversation
// until one of:
//
//   * the model produces a final assistant message with no tool calls
//   * a tool call needs approval → pause with kind="approval"
//   * the model calls ask_user → pause with kind="question"
//   * maxTurns is reached → return "max_turns"
//   * an error is thrown → mark thread error, rethrow
//
// Both pause kinds use a single "awaiting_input" thread state. The
// resume API accepts either an approval decision or a free-text answer
// and dispatches to the right handler. From the LLM's perspective both
// look like a normal tool call that simply takes a long time to return.

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { appendTrace } from "./trace.mjs";
import { chat } from "./llm/openai-compatible.mjs";
import { Decision } from "./sandbox.mjs";
import { ThreadStatus } from "./threads.mjs";
import { readMessagesSince } from "./messages-log.mjs";
import { publish } from "./event-bus.mjs";

import { SANDBOX_FRAMING, AVAILABLE_TOOLS, DENIED_TOOLS, SKILLS_HEADER } from "./prompts.mjs";
import { buildToolPolicy } from "./agent-defs.mjs";
import { discoverSkills, skillAllowed } from "./skills.mjs";

// Per-thread set of absolute directory paths touched by Read/Write/Edit.
// Used to inject CLAUDE.md from subdirectories the agent works in.
const visitedDirs = new Map(); // threadId → Set<absDir>

// The active run's abort signal. In the detached-runner model each process
// runs exactly one thread, so a module-scoped reference is safe and lets tools
// observe cancellation (stop / hard-interrupt) without threading the signal
// through every dispatch call.
let activeSignal = null;


/**
 * Stable name this agent publishes and receives under. ADR 0003 will
 * replace this with a real agent definition; until then we derive a
 * short, human-readable handle from the thread id so dogfooding is
 * possible without introducing a new createThread parameter yet.
 */
function agentNameFor(thread) {
  return thread.agentDef?.name || thread.agentName || `agent-${thread.id.slice(0, 8)}`;
}

/**
 * Does `message.to` address `self`?
 * - string: exact match or "*"
 * - array: contains self or "*"
 */
function addressedTo(message, self) {
  const to = message.to;
  if (typeof to === "string") return to === self || to === "*";
  if (Array.isArray(to)) return to.includes(self) || to.includes("*");
  return false;
}

// 20 was too tight for realistic multi-file tasks: a single edit_file
// mishap (e.g. indent mismatch) already costs several turns of retries,
// and legitimate refactors touch 5+ files. 40 gives honest headroom
// without letting a runaway loop burn forever.
const DEFAULT_MAX_TURNS = 40;

/**
 * Run a thread. Two main entry modes:
 *   - send a new user message (userMessage != null, no resumeInput)
 *   - resume from a paused state (resumeInput, userMessage == null)
 *
 * @param {object} ctx
 * @param {object} ctx.thread            — thread meta from thread manager
 * @param {object} ctx.threadMgr
 * @param {object} ctx.sandbox
 * @param {object} ctx.registry
 * @param {object} ctx.profile
 * @param {string|null} ctx.userMessage  — new user message, or null when resuming
 * @param {object} [ctx.resumeInput]     — resolution payload for a pending pause:
 *   for kind=approval: { toolCallId, decision: "allow"|"deny", persist?: boolean }
 *   for kind=question: { toolCallId, answer: string }
 * @param {string} [ctx.pluginRoot]      — absolute path to the plugin root (for skill discovery)
 * @param {AbortSignal} [ctx.signal]
 */
export async function runThread(ctx) {
  const {
    thread,
    threadMgr,
    sandbox,
    registry,
    profile,
    userMessage,
    resumeInput,
    pluginRoot,
    signal,
  } = ctx;
  activeSignal = signal ?? null;

  const maxTurns = thread.agentDef?.maxTurns ?? profile.maxTurns ?? DEFAULT_MAX_TURNS;

  await threadMgr.setStatus(thread.id, ThreadStatus.RUNNING, { pending: null, error: null });

  // Emit a thread_start trace entry on the very first run. Subsequent resumes
  // skip this so the trace file has exactly one thread_start at the top.
  if (!thread.traceStarted) {
    await threadMgr.updateThread(thread.id, { traceStarted: true });
    Object.assign(thread, { traceStarted: true });
    // Logged after buildMessages so we have the initial system prompt — see
    // the turn_start emission inside the loop below (turn === 0 adds tools).
  }

  try {
    if (userMessage != null) {
      await threadMgr.appendMessage(thread.id, { role: "user", content: userMessage });
    }

    if (resumeInput) {
      const handled = await resolvePending({
        thread,
        threadMgr,
        sandbox,
        registry,
        resume: resumeInput,
        pluginRoot,
      });
      // resolvePending may itself surface a new pause (e.g. another
      // unanswered tool call from the same assistant turn).
      if (handled.status === "awaiting_input") return handled;
    }

    for (let turn = 0; turn < maxTurns; turn++) {
      if (signal?.aborted) throw new Error("aborted");

      // Drain any leftover unanswered tool calls from the previous
      // assistant turn before asking the LLM for another one.
      const leftover = await drainLeftoverToolCalls({
        thread,
        threadMgr,
        sandbox,
        registry,
        pluginRoot,
      });
      if (leftover?.status === "awaiting_input") return leftover;

      // Deliver any new mail addressed to this agent into the thread
      // history as a synthetic user message. ADR 0002 calls this
      // "inbox drain at the top of each turn". The cursor is persisted
      // so a server restart does not re-deliver old mail.
      await drainMailbox({ thread, threadMgr });
      // Re-read thread meta because drainMailbox may have advanced
      // inboxCursor. buildMessages uses thread.id, not the stale ref,
      // but other downstream callers (dispatchToolCall, ctx) still
      // carry the old `thread` object — we refresh it once here.
      Object.assign(thread, (await threadMgr.getThread(thread.id)) || thread);

      const messages = await buildMessages({ thread, threadMgr, profile, registry, pluginRoot });
      const tools = registry.toOpenAISchema();

      // Emit a trace entry before each LLM call so we have a turn-by-turn
      // record of what the agent saw. Turn 0 also includes the tool list
      // (static for the life of the thread) to make the trace self-contained.
      const traceEntry = {
        type: turn === 0 ? "thread_start" : "turn_start",
        turn,
        systemPrompt: messages[0].content,
        ...(turn === 0 ? { tools: registry.list().map((t) => ({ name: t.name, description: t.description })) } : {}),
      };
      appendTrace(thread, traceEntry);

      const { message, finishReason, usage } = await chat({
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey,
        model: profile.model,
        messages,
        tools,
        temperature: thread.agentDef?.temperature ?? profile.temperature,
        maxTokens: profile.maxTokens,
        ...(profile.llmTimeoutMs != null ? { timeoutMs: profile.llmTimeoutMs } : {}),
        signal,
      });
      if (usage) appendTrace(thread, { type: "usage", turn, ...usage });

      // Persist the assistant message before running any tool calls.
      const assistantMsg = {
        role: "assistant",
        content: message.content ?? null,
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      };
      await threadMgr.appendMessage(thread.id, assistantMsg);

      const toolCalls = message.tool_calls || [];
      if (toolCalls.length === 0) {
        const finalContent = message.content || "";
        await threadMgr.setStatus(thread.id, ThreadStatus.IDLE, { pending: null, summary: summarize(finalContent) });
        visitedDirs.delete(thread.id);
        publish(thread.cwd, {
          from: agentNameFor(thread), to: "parent", kind: "say", urgent: true,
          text: `[${thread.id}] Agent finished.\n${finalContent}`,
        }).catch(() => {});
        return { status: "final", content: finalContent, finishReason };
      }

      for (const call of toolCalls) {
        const outcome = await dispatchToolCall({
          call,
          sandbox,
          registry,
          thread,
          threadMgr,
          pluginRoot,
        });
        if (outcome.status === "awaiting_input") return outcome;
      }
    }

    // Reaching max_turns means the inner loop just finished dispatching
    // all tool calls of an assistant turn, so the history currently ends
    // on a tool result. Appending a follow-up user message on top of a
    // tool result violates strict user/assistant alternation in some
    // provider templates (Mistral's, notably — it 400s). Close the
    // sequence with a synthetic assistant turn so the thread is cleanly
    // resumable from a new user instruction.
    const tail = await threadMgr.readMessages(thread.id);
    const lastMsg = tail[tail.length - 1];
    if (lastMsg && lastMsg.role !== "assistant") {
      await threadMgr.appendMessage(thread.id, {
        role: "assistant",
        content: `(Reached the turn limit of ${maxTurns} before finishing. All work done so far is persisted. Ready to continue on a follow-up instruction.)`,
      });
    }
    await threadMgr.setStatus(thread.id, ThreadStatus.IDLE, { pending: null, summary: `reached turn limit (${maxTurns})` });
    visitedDirs.delete(thread.id);
    publish(thread.cwd, {
      from: agentNameFor(thread), to: "parent", kind: "say", urgent: true,
      text: `[${thread.id}] Agent reached turn limit (${maxTurns}). Work so far is persisted — send a follow-up to continue.`,
    }).catch(() => {});
    return { status: "max_turns", content: `reached max_turns (${maxTurns})` };
  } catch (err) {
    // If the loop was aborted intentionally (agent_stop), the status is
    // already set to STOPPED — don't overwrite it with ERROR.
    visitedDirs.delete(thread.id);
    if (signal?.aborted) return { status: "stopped" };
    await threadMgr.setStatus(thread.id, ThreadStatus.ERROR, {
      error: { message: err.message, stack: err.stack },
      pending: null,
    });
    publish(thread.cwd, {
      from: agentNameFor(thread), to: "parent", kind: "error", urgent: true,
      text: `[${thread.id}] Agent error: ${err.message}`,
    }).catch(() => {});
    throw err;
  }
}

/**
 * After a resume (or defensively, at the start of each turn), inspect
 * the most recent assistant message. If it had multiple tool_calls and
 * only some were answered, process the unanswered ones in order. If one
 * triggers a pause, surface it. If all are answered, this is a no-op.
 */
async function drainLeftoverToolCalls({ thread, threadMgr, sandbox, registry, pluginRoot }) {
  const history = await threadMgr.readMessages(thread.id);
  let lastAsstIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant" && Array.isArray(history[i].tool_calls)) {
      lastAsstIdx = i;
      break;
    }
    if (history[i].role === "user") return null;
  }
  if (lastAsstIdx === -1) return null;

  const lastAsst = history[lastAsstIdx];
  const answered = new Set();
  for (let i = lastAsstIdx + 1; i < history.length; i++) {
    if (history[i].role === "tool" && history[i].tool_call_id) {
      answered.add(history[i].tool_call_id);
    }
  }

  for (const call of lastAsst.tool_calls) {
    if (answered.has(call.id)) continue;
    const outcome = await dispatchToolCall({
      call,
      sandbox,
      registry,
      thread,
      threadMgr,
      pluginRoot,
    });
    if (outcome.status === "awaiting_input") return outcome;
  }
  return null;
}

/**
 * Read new messages from <cwd>/.claude/agnz/messages.jsonl since the
 * thread's persisted inboxCursor. Of those, deliver the ones addressed
 * to this agent (exact name, "*", or array containing either) as a
 * synthetic user message, skipping messages the agent sent itself so
 * they don't echo back. The cursor advances to the last *observed*
 * message id (not just delivered ones) so unrelated traffic in the
 * workspace doesn't get re-scanned on every turn.
 */
async function drainMailbox({ thread, threadMgr }) {
  const cursor = thread.inboxCursor || null;
  const all = await readMessagesSince(thread.cwd, cursor);
  if (all.length === 0) return;

  const self = agentNameFor(thread);
  const delivered = all.filter(
    (m) => addressedTo(m, self) && m.from !== self,
  );

  // Advance cursor to the last observed id regardless of whether any
  // of them were addressed to us. Otherwise every turn re-reads the
  // same uninteresting traffic from chatty workspaces.
  const lastObservedId = all[all.length - 1].id;

  if (delivered.length > 0) {
    const body = delivered
      .map((m) => {
        const ref = m.ref ? ` (re: ${m.ref})` : "";
        const urgent = m.urgent ? " [URGENT]" : "";
        const item = m.item_id ? ` [item=${m.item_id}]` : "";
        return `- ${m.id} ${m.from} → ${JSON.stringify(m.to)} ${m.kind}${urgent}${item}${ref}: ${m.text}`;
      })
      .join("\n");
    await threadMgr.appendMessage(thread.id, {
      role: "user",
      content: `Inbox update — ${delivered.length} new message(s) since your last turn:\n${body}`,
    });
  }

  await threadMgr.updateThread(thread.id, { inboxCursor: lastObservedId });
}

async function buildMessages({ thread, threadMgr, profile, registry, pluginRoot }) {
  const messages = [];

  // Build system prompt in layers (ADR 0003, ADR 0006):
  //   1. sandbox-framing (always)
  //   2. tool restrictions (always, if any tools are denied)
  //   3. injected skills (if agentDef.skills is set)
  //   4. agent prompt (if agentDef.prompt exists, supplements sandbox-framing)
  // When no agent def is in play, fall back to profile/thread systemPrompt.
  // Derive policy from agentDef at runtime — not stored in thread meta.
  const effectivePolicy = thread.agentDef
    ? buildToolPolicy(thread.agentDef, registry.list().map(t => t.name))
    : null;

  let system;
  if (thread.agentDef) {
    const parts = [defaultSystemPrompt(thread)];

    // Inject CLAUDE.md files — startup: cwd upward to home; runtime: visited subdirs.
    const claudeMds = await collectClaudeMds(
      thread.cwd,
      [...(visitedDirs.get(thread.id) || [])],
    );
    if (claudeMds.length > 0) {
      parts.push(claudeMds.map(({ content }) => content).join("\n\n---\n\n"));
    }

    // Tool restrictions: always list all tools, mark denied ones
    const toolNote = buildToolRestrictionsNote(effectivePolicy);
    if (toolNote) parts.push(toolNote);

    // Inject skill catalog: name + description only. Agent loads full content
    // on demand via Skill({action:"load", name:"..."}).
    const skillFilter = Array.isArray(thread.agentDef.skills) ? thread.agentDef.skills : null;
    const catalog = await buildSkillCatalog(thread.cwd, skillFilter, pluginRoot);
    if (catalog.length > 0) parts.push(SKILLS_HEADER + "\n" + catalog.join("\n"));
    // Agent prompt/body goes into the system prompt. Putting it as a user
    // message (old ADR 0003 design) causes consecutive user messages on the
    // first turn, which breaks strict-alternation model templates (Mistral 400s).
    if (thread.agentDef.prompt) parts.push(thread.agentDef.prompt);
    else if (thread.agentDef.body) parts.push(thread.agentDef.body);
    system = parts.join("\n\n");
  } else {
    system = profile.systemPrompt || thread.systemPrompt || defaultSystemPrompt(thread);
    // No agent def means no policy — show no tool restrictions note.
  }
  messages.push({ role: "system", content: system });

  const history = await threadMgr.readMessages(thread.id);
  for (const m of history) {
    const { ts, ...rest } = m;
    messages.push(rest);
  }
  return messages;
}

function defaultSystemPrompt(thread) {
  return SANDBOX_FRAMING.replace("{cwd}", thread.cwd);
}

/**
 * Build a tool restrictions note for the system prompt.
 * Always lists all available tools; marks denied ones explicitly.
 */
function buildToolRestrictionsNote(policy) {
  if (!policy || typeof policy !== "object") return null;

  const allowed = [];
  const denied = [];

  for (const [tool, decision] of Object.entries(policy)) {
    if (decision === "allow" || decision === "ask") {
      allowed.push(tool);
    } else if (decision === "deny") {
      denied.push(tool);
    }
  }

  if (allowed.length === 0 && denied.length === 0) return null;

  const lines = [];
  lines.push(AVAILABLE_TOOLS.replace("{allowed}", allowed.join(", ")));
  if (denied.length > 0) {
    lines.push(DENIED_TOOLS.replace("{denied}", denied.join(", ")));
  }
  return lines.join("\n");
}

/**
 * Build the skill catalog for the system prompt: name + description only.
 * The sub-agent sees the catalog at startup and calls Skill({action:"load",
 * name:"..."}) for the full body on demand. Discovery is the shared one in
 * skills.mjs, so this catalog and the Skill tool can never drift.
 * `skillNames` (agent def `skills:`) narrows the list; null = all skills.
 */
async function buildSkillCatalog(cwd, skillNames, pluginRoot) {
  const catalog = await discoverSkills(cwd, pluginRoot);
  if (catalog.size === 0) return [];
  const allowList = Array.isArray(skillNames) ? skillNames : null;
  return [...catalog.values()]
    .filter((entry) => skillAllowed(allowList, entry))
    .map((sk) => (sk.description ? `- ${sk.name}: ${sk.description}` : `- ${sk.name}`));
}

/**
 * Dispatch a single tool_call. Returns one of:
 *   { status: "ok" }                       — tool ran (or was denied), result appended
 *   { status: "awaiting_input", pending }  — paused, caller must resume
 */
async function dispatchToolCall({ call, sandbox, registry, thread, threadMgr, pluginRoot }) {
  const name = call?.function?.name;
  const toolCallId = call?.id || `call_${Date.now()}`;
  const tool = registry.get(name);

  if (!tool) {
    await appendToolResult(threadMgr, thread.id, toolCallId, `Error: unknown tool '${name}'`);
    return { status: "ok" };
  }

  let args;
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch (_firstErr) {
    // Local models (e.g. Devstral) sometimes emit unescaped backslashes in
    // string values (PHP namespaces, Windows paths, regex). Repair and retry
    // before giving up: double any \ not already part of a valid JSON escape.
    try {
      const repaired = (call.function.arguments || "").replace(
        /\\(?!["\\/bfnrtu])/g,
        "\\\\",
      );
      args = JSON.parse(repaired);
    } catch (err) {
      await appendToolResult(
        threadMgr,
        thread.id,
        toolCallId,
        `Error: invalid JSON arguments: ${err.message}`,
      );
      return { status: "ok" };
    }
  }

  // Special-case: AskUser is intercepted before policy / run.
  if (name === "AskUser") {
    if (typeof args.question !== "string" || !args.question.trim()) {
      await appendToolResult(
        threadMgr,
        thread.id,
        toolCallId,
        `Error: AskUser requires a non-empty 'question' string`,
      );
      return { status: "ok" };
    }
    const pending = {
      toolCallId,
      kind: "question",
      question: args.question,
      options: Array.isArray(args.options) ? args.options : null,
      context: typeof args.context === "string" ? args.context : null,
    };
    await threadMgr.setStatus(thread.id, ThreadStatus.AWAITING_INPUT, { pending, summary: `asked: ${String(args.question).slice(0, 120)}` });
    publish(thread.cwd, {
      from: agentNameFor(thread), to: "parent", kind: "question", urgent: true,
      text: `[${thread.id}] Agent paused — waiting for answer.\nQuestion: ${args.question}`,
    }).catch(() => {});
    return { status: "awaiting_input", pending };
  }

  const decision = sandbox.checkPermission(name);

  // Bash has special logic: check workspace.json + session approvals
  // Bash: check thread sessionCommands before falling through to the
  // general ask/deny logic. Previously-approved commands run without
  // interruption; previously-denied ones fail immediately.
  if (name === "Bash" && decision === Decision.ASK) {
    const command = typeof args?.command === "string" ? args.command.trim() : "";
    const sc = thread.sessionCommands || {};
    if (sc.sessionAllow?.includes(command)) {
      return runToolAndAppend({ tool, args, toolCallId, sandbox, thread, threadMgr, pluginRoot });
    }
    if (sc.sessionDeny?.includes(command)) {
      await appendToolResult(threadMgr, thread.id, toolCallId, `Error: command '${command}' is denied.`);
      return { status: "ok" };
    }
    // not in session lists → fall through to ask pause
  }

  // Denied by policy
  if (decision === Decision.DENY) {
    await appendToolResult(
      threadMgr,
      thread.id,
      toolCallId,
      `Error: tool '${name}' is denied.`,
    );
    return { status: "ok" };
  }

  // Ask → pause for approval
  if (decision === Decision.ASK) {
    const pending = { toolCallId, kind: "approval", name, args };
    await threadMgr.setStatus(thread.id, ThreadStatus.AWAITING_INPUT, { pending, summary: `needs approval: ${name}` });
    const argsPreview = JSON.stringify(args).slice(0, 120);
    publish(thread.cwd, {
      from: agentNameFor(thread), to: "parent", kind: "question", urgent: true,
      text: `[${thread.id}] Agent paused — approval needed for tool **${name}**.\nArgs: ${argsPreview}\nCall \`thread_approve\` to allow or deny.`,
    }).catch(() => {});
    return { status: "awaiting_input", pending };
  }

  return runToolAndAppend({ tool, args, toolCallId, sandbox, thread, threadMgr, pluginRoot });
}

async function runToolAndAppend({ tool, args, toolCallId, sandbox, thread, threadMgr, pluginRoot }) {
  try {
    const result = await tool.run(args, { sandbox, thread, threadMgr, pluginRoot, agentName: agentNameFor(thread), signal: activeSignal });
    const raw = typeof result?.content === "string" ? result.content : JSON.stringify(result);
    const content = sanitizeForModel(raw, sandbox.getRoot());
    await appendToolResult(threadMgr, thread.id, toolCallId, content);
    // Track dirs touched by file tools so CLAUDE.md can be injected on the next turn.
    if (args.path && (tool.name === "Read" || tool.name === "Write" || tool.name === "Edit")) {
      const abs = args.path.startsWith("/") ? args.path : resolve(thread.cwd, args.path);
      const dir = dirname(abs);
      if (dir.startsWith(thread.cwd)) {
        if (!visitedDirs.has(thread.id)) visitedDirs.set(thread.id, new Set());
        visitedDirs.get(thread.id).add(dir);
      }
    }
    return { status: "ok" };
  } catch (err) {
    const msg = sanitizeForModel(err.message || String(err), sandbox.getRoot());
    await appendToolResult(
      threadMgr,
      thread.id,
      toolCallId,
      `Error: ${tool.name} failed: ${msg}`,
    );
    return { status: "ok" };
  }
}

/**
 * Strip the absolute sandbox root from any string before it reaches the
 * model. Centralised so every tool result — success or error — is sanitised
 * in one place, and no internal absolute path leaks into the transcript.
 */
function sanitizeForModel(str, root) {
  if (typeof str !== "string" || !root) return str;
  return str.split(root + "/").join("").split(root).join(".");
}

// One-line rolling summary of where a thread stands, written to meta.summary
// on every pause/finish. The parent (and `agnz list`/`show`) read it to see
// reusable context without opening the transcript. Cheap: derived from the
// agent's own latest output, no extra LLM call.
function summarize(text) {
  if (typeof text !== "string") return null;
  const line = text.trim().split("\n").find((l) => l.trim()) || text.trim();
  return line.slice(0, 140) || null;
}

async function appendToolResult(threadMgr, threadId, toolCallId, content) {
  await threadMgr.appendMessage(threadId, {
    role: "tool",
    tool_call_id: toolCallId,
    content,
  });
}

/**
 * Collect CLAUDE.md files: the cwd's own CLAUDE.md (startup context), plus any
 * visited subdirectory CLAUDE.md files (runtime context from file ops).
 * Returns array of { path, content } sorted outer→inner (general first).
 * Missing files are silently skipped; duplicates are deduplicated.
 */
async function collectClaudeMds(cwd, extraDirs = []) {
  const seen = new Set();
  const results = [];

  // cwd itself first
  const cwdMd = resolve(cwd, "CLAUDE.md");
  seen.add(cwdMd);
  try { results.push({ path: cwdMd, content: (await readFile(cwdMd, "utf8")).trim() }); } catch { /* absent */ }

  // Visited subdirs within cwd: build chain from just-below-cwd down to the dir
  for (const extraDir of extraDirs) {
    if (!extraDir.startsWith(cwd + "/")) continue;
    const chain = [];
    let cur = extraDir;
    while (cur.startsWith(cwd + "/")) {
      chain.unshift(cur);
      cur = dirname(cur);
    }
    for (const dir of chain) {
      const p = resolve(dir, "CLAUDE.md");
      if (seen.has(p)) continue;
      seen.add(p);
      try { results.push({ path: p, content: (await readFile(p, "utf8")).trim() }); } catch { /* absent */ }
    }
  }

  return results;
}

/**
 * Resume a paused thread. The pending record's `kind` decides how the
 * resume payload is interpreted.
 *
 *   kind="approval" + resume.decision="allow" → run the pending tool now
 *   kind="approval" + resume.decision="deny"  → inject a denial as the tool result
 *   kind="question"                            → inject resume.answer as the tool result
 *
 * Returns { status: "ok" } when the pending call has been resolved and
 * the loop should continue, or another { status: "awaiting_input" } if
 * resolving it surfaces another pause.
 */
async function resolvePending({ thread, threadMgr, sandbox, registry, resume, pluginRoot }) {
  const pending = thread.pending;
  if (!pending || pending.toolCallId !== resume.toolCallId) {
    throw new Error(
      `agent: resume mismatch — expected ${pending?.toolCallId}, got ${resume.toolCallId}`,
    );
  }

  if (pending.kind === "question") {
    const answer = typeof resume.answer === "string" ? resume.answer : "";
    if (!answer.trim()) {
      throw new Error("agent: resume of a question pause requires a non-empty 'answer' string");
    }
    await appendToolResult(threadMgr, thread.id, pending.toolCallId, answer);
    await threadMgr.setStatus(thread.id, ThreadStatus.RUNNING, { pending: null });
    return { status: "ok" };
  }

  // pending.kind === "approval"
  const decision = resume.decision;
  if (decision !== Decision.ALLOW && decision !== Decision.DENY) {
    throw new Error(`agent: invalid approval decision '${decision}' (expected allow|deny)`);
  }

  // All approvals are session-scoped only.
  // Bash: track at the command level in sessionCommands so the same command
  // does not ask twice in the same session. Other tools: record in sandbox.
  if (pending.name === "Bash") {
    const command = typeof pending.args?.command === "string" ? pending.args.command.trim() : "";
    if (command) {
      const list = decision === Decision.ALLOW ? "sessionAllow" : "sessionDeny";
      // Functional patch: read sessionCommands from the latest committed
      // meta inside the serialised mutate, not from the (possibly stale)
      // in-memory `thread`, so a concurrent approval can't drop a command.
      await threadMgr.updateThread(thread.id, (cur) => {
        const sc = cur.sessionCommands || { sessionAllow: [], sessionDeny: [] };
        if (sc[list].includes(command)) return {};
        return { sessionCommands: { ...sc, [list]: [...sc[list], command] } };
      });
    }
  } else {
    sandbox.recordDecision(pending.name, decision);
  }

  if (decision === Decision.DENY) {
    await appendToolResult(
      threadMgr,
      thread.id,
      pending.toolCallId,
      `Error: tool '${pending.name}' was denied by the user.`,
    );
    await threadMgr.setStatus(thread.id, ThreadStatus.RUNNING, { pending: null });
    return { status: "ok" };
  }

  // ALLOW — actually run the pending tool now.
  const tool = registry.get(pending.name);
  if (!tool) {
    await appendToolResult(
      threadMgr,
      thread.id,
      pending.toolCallId,
      `Error: unknown tool '${pending.name}'`,
    );
    await threadMgr.setStatus(thread.id, ThreadStatus.RUNNING, { pending: null });
    return { status: "ok" };
  }

  try {
    const result = await tool.run(pending.args, { sandbox, thread, threadMgr, pluginRoot, agentName: agentNameFor(thread), signal: activeSignal });
    const raw = typeof result?.content === "string" ? result.content : JSON.stringify(result);
    const content = sanitizeForModel(raw, sandbox.getRoot());
    await appendToolResult(threadMgr, thread.id, pending.toolCallId, content);
  } catch (err) {
    const msg = sanitizeForModel(err.message || String(err), sandbox.getRoot());
    await appendToolResult(
      threadMgr,
      thread.id,
      pending.toolCallId,
      `Error: ${pending.name} failed: ${msg}`,
    );
  }
  await threadMgr.setStatus(thread.id, ThreadStatus.RUNNING, { pending: null });
  return { status: "ok" };
}
