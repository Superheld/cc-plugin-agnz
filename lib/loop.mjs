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
import { resolve } from "node:path";
import { appendTrace } from "./trace.mjs";
import { chat } from "./llm/openai-compatible.mjs";
import { Decision } from "./sandbox.mjs";
import { ThreadStatus } from "./threads.mjs";
import { readMessagesSince } from "./messages-log.mjs";

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
    signal,
  } = ctx;

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

      const messages = await buildMessages({ thread, threadMgr, profile });
      const tools = registry.toOpenAISchema();

      // Emit a trace entry before each LLM call so we have a turn-by-turn
      // record of what the agent saw. Turn 0 also includes the tool list
      // (static for the life of the thread) to make the trace self-contained.
      const traceEntry = {
        type: turn === 0 ? "thread_start" : "turn_start",
        turn,
        systemPrompt: messages[0].content,
        openFiles: Object.keys(thread.openFiles || {}),
        ...(turn === 0 ? { tools: registry.list().map((t) => ({ name: t.name, description: t.description })) } : {}),
      };
      appendTrace(thread, traceEntry);

      const { message, finishReason } = await chat({
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey,
        model: profile.model,
        messages,
        tools,
        temperature: thread.agentDef?.temperature ?? profile.temperature,
        maxTokens: profile.maxTokens,
        signal,
      });

      // Persist the assistant message before running any tool calls.
      const assistantMsg = {
        role: "assistant",
        content: message.content ?? null,
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      };
      await threadMgr.appendMessage(thread.id, assistantMsg);

      const toolCalls = message.tool_calls || [];
      if (toolCalls.length === 0) {
        await threadMgr.setStatus(thread.id, ThreadStatus.IDLE, { pending: null });
        return {
          status: "final",
          content: message.content || "",
          finishReason,
        };
      }

      for (const call of toolCalls) {
        const outcome = await dispatchToolCall({
          call,
          sandbox,
          registry,
          thread,
          threadMgr,
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
    await threadMgr.setStatus(thread.id, ThreadStatus.IDLE, { pending: null });
    return { status: "max_turns", content: `reached max_turns (${maxTurns})` };
  } catch (err) {
    await threadMgr.setStatus(thread.id, ThreadStatus.ERROR, {
      error: { message: err.message, stack: err.stack },
      pending: null,
    });
    throw err;
  }
}

/**
 * After a resume (or defensively, at the start of each turn), inspect
 * the most recent assistant message. If it had multiple tool_calls and
 * only some were answered, process the unanswered ones in order. If one
 * triggers a pause, surface it. If all are answered, this is a no-op.
 */
async function drainLeftoverToolCalls({ thread, threadMgr, sandbox, registry }) {
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

async function buildMessages({ thread, threadMgr, profile }) {
  const messages = [];

  // Build system prompt in layers (ADR 0003, ADR 0010):
  //   1. sandbox-framing (always) + one-line workspace status note
  //   2. skill catalog (if agentDef.skills is set)
  //   3. agent def body (if agentDef.body exists)
  // File content is NOT in the system prompt — it is prepended to the first
  // user message in the history so it sits at the top of the conversation
  // without inflating the static system prompt on every turn (ADR 0010).
  let system;
  if (thread.agentDef) {
    const parts = [defaultSystemPrompt(thread)];
    const wsNote = buildWorkspaceNote(thread.openFiles, profile.contextTokens);
    if (wsNote) parts.push(wsNote);
    const skills = thread.agentDef.skills;
    if (Array.isArray(skills) && skills.length > 0) {
      const catalog = await buildSkillCatalog(thread.cwd, skills);
      if (catalog.length > 0) {
        parts.push(
          "Available skills (call Skill({action:\"load\", name:\"...\"}) to load the full content of one):\n" +
          catalog.join("\n"),
        );
      }
    }
    if (thread.agentDef.body) parts.push(thread.agentDef.body);
    system = parts.join("\n\n");
  } else {
    const base = profile.systemPrompt || thread.systemPrompt || defaultSystemPrompt(thread);
    const wsNote = buildWorkspaceNote(thread.openFiles, profile.contextTokens);
    system = wsNote ? `${base}\n\n${wsNote}` : base;
  }
  messages.push({ role: "system", content: system });

  // Inject one synthetic user message per open file, before the conversation
  // history. Each file gets its own message so files are individually
  // replaceable when updated by an Edit or Write. The model sees them as
  // context at the top of the conversation — not as instructions (that is the
  // system prompt's job). Consecutive synthetic user messages are fine for
  // OpenAI-compatible endpoints; Mistral templates merge them into the first
  // [INST] block which is exactly what we want (ADR 0010).
  for (const [path, entry] of Object.entries(thread.openFiles || {})) {
    const content = entry.content || "";
    const lines = content.split("\n");
    const numbered = lines
      .map((l, i) => `${String(i + 1).padStart(5, " ")}  ${l}`)
      .join("\n");
    messages.push({
      role: "user",
      content: `=== workspace: ${path} (${lines.length} lines, always current) ===\n${numbered}`,
    });
  }

  const history = await threadMgr.readMessages(thread.id);
  for (const m of history) {
    const { ts, ...rest } = m;
    messages.push(rest);
  }
  return messages;
}

// Conservative default context budget for workspace usage warnings. Can be
// overridden per-profile with profile.contextTokens (not yet in the schema).
const CONTEXT_BUDGET_TOKENS = 40_000;

function defaultSystemPrompt(thread) {
  const lines = [
    "You are a coding sub-agent running inside a sandbox.",
    `Your working directory is: ${thread.cwd}`,
    "All file paths you pass to tools are interpreted relative to this root.",
    "You cannot access files outside this directory.",
    "",
    "Operating principles:",
    "- Do the work yourself. Use the available tools to inspect, search, and modify files.",
    "- Open files appear at the top of this conversation (before the task) and are always current. After an Edit or Write the content updates automatically — you do not need to re-read an open file. Use Close when you are done with a file.",
    "- Do not narrate every step. Tool calls speak for themselves; the orchestrator can read your transcript later if it needs detail.",
    "- Use AskUser ONLY for genuine clarifications you cannot decide on your own (ambiguous requirements, missing input). Do not use it to confirm obvious actions or to report progress.",
    "- When you finish, reply with a short factual summary of what changed (which files, what was added/removed). One paragraph max.",
    "- Emit exactly ONE tool call per turn. Never batch multiple tool calls in a single response. Some local-model chat templates (notably Mistral) corrupt multi-call turns and cascade into parse errors that destroy the thread.",
  ];

  return lines.join("\n");
}

/**
 * One-line workspace status note for the system prompt — metadata only,
 * no file content. The actual content is injected at the top of the message
 * history via buildFilesBlock(). Returns null when no files are open.
 */
function buildWorkspaceNote(openFiles, contextTokens) {
  const budget = contextTokens || CONTEXT_BUDGET_TOKENS;
  const entries = Object.entries(openFiles || {});
  if (entries.length === 0) return null;

  let totalChars = 0;
  for (const [, entry] of entries) totalChars += (entry.content || "").length;
  const tokens = Math.ceil(totalChars / 4);
  const pct = Math.min(99, Math.round((tokens / budget) * 100));
  const names = entries.map(([p]) => p.split("/").pop()).join(", ");
  const warning = pct >= 80
    ? ` ⚠ Working memory at ${pct}% — close files you no longer need.`
    : "";

  return (
    `Workspace: ${entries.length} file${entries.length === 1 ? "" : "s"} open` +
    ` (${names}) — content at top of conversation, always current.` +
    ` Do not call Read on open files; use Close when done.${warning}`
  );
}


/**
 * Build a skill catalog for the system prompt: name + description only.
 * The sub-agent sees the catalog at startup and calls Skill({action:"load",
 * name:"..."}) to pull in the full SKILL.md body on demand — same
 * progressive-disclosure model as the main Claude Code session.
 * Unknown skill names are skipped silently.
 */
async function buildSkillCatalog(cwd, skillNames) {
  const entries = [];
  for (const name of skillNames) {
    const skillPath = resolve(cwd, ".claude", "skills", name, "SKILL.md");
    let source;
    try {
      source = await readFile(skillPath, "utf8");
    } catch {
      continue; // skill not found — skip silently
    }
    // Extract description from frontmatter.
    const lines = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
    let description = "";
    let inFrontmatter = false;
    for (const line of lines) {
      if (line.trim() === "---") { inFrontmatter = !inFrontmatter; continue; }
      if (!inFrontmatter) break;
      const m = line.match(/^description\s*:\s*(.+)$/);
      if (m) { description = m[1].trim(); break; }
    }
    entries.push(`- ${name}: ${description || "(no description)"}`);
  }
  return entries;
}

/**
 * Dispatch a single tool_call. Returns one of:
 *   { status: "ok" }                       — tool ran (or was denied), result appended
 *   { status: "awaiting_input", pending }  — paused, caller must resume
 */
async function dispatchToolCall({ call, sandbox, registry, thread, threadMgr }) {
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
  } catch (err) {
    await appendToolResult(
      threadMgr,
      thread.id,
      toolCallId,
      `Error: invalid JSON arguments: ${err.message}`,
    );
    return { status: "ok" };
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
    await threadMgr.setStatus(thread.id, ThreadStatus.AWAITING_INPUT, { pending });
    return { status: "awaiting_input", pending };
  }

  const decision = sandbox.checkPermission(name);

  if (decision === Decision.DENY) {
    await appendToolResult(
      threadMgr,
      thread.id,
      toolCallId,
      `Error: tool '${name}' is denied by sandbox policy.`,
    );
    return { status: "ok" };
  }

  if (decision === Decision.ASK) {
    const pending = { toolCallId, kind: "approval", name, args };
    await threadMgr.setStatus(thread.id, ThreadStatus.AWAITING_INPUT, { pending });
    return { status: "awaiting_input", pending };
  }

  return runToolAndAppend({ tool, args, toolCallId, sandbox, thread, threadMgr });
}

async function runToolAndAppend({ tool, args, toolCallId, sandbox, thread, threadMgr }) {
  try {
    // Pass threadMgr so workspace tools (Read, Edit, Write, Close) can update
    // openFiles state in the thread meta (ADR 0010).
    const result = await tool.run(args, { sandbox, thread, threadMgr, agentName: agentNameFor(thread) });
    const content = typeof result?.content === "string" ? result.content : JSON.stringify(result);
    await appendToolResult(threadMgr, thread.id, toolCallId, content);
    return { status: "ok" };
  } catch (err) {
    await appendToolResult(
      threadMgr,
      thread.id,
      toolCallId,
      `Error running ${tool.name}: ${err.message}`,
    );
    return { status: "ok" };
  }
}

async function appendToolResult(threadMgr, threadId, toolCallId, content) {
  await threadMgr.appendMessage(threadId, {
    role: "tool",
    tool_call_id: toolCallId,
    content,
  });
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
async function resolvePending({ thread, threadMgr, sandbox, registry, resume }) {
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

  // pending.kind === "approval" (or undefined for old persisted state)
  const decision = resume.decision;
  if (decision !== Decision.ALLOW && decision !== Decision.DENY) {
    throw new Error(`agent: invalid approval decision '${decision}' (expected allow|deny)`);
  }

  if (resume.persist) {
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
    const result = await tool.run(pending.args, { sandbox, thread, threadMgr, agentName: agentNameFor(thread) });
    const content = typeof result?.content === "string" ? result.content : JSON.stringify(result);
    await appendToolResult(threadMgr, thread.id, pending.toolCallId, content);
  } catch (err) {
    await appendToolResult(
      threadMgr,
      thread.id,
      pending.toolCallId,
      `Error running ${pending.name}: ${err.message}`,
    );
  }
  await threadMgr.setStatus(thread.id, ThreadStatus.RUNNING, { pending: null });
  return { status: "ok" };
}
