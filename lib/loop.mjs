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
import { existsSync, statSync } from "node:fs";
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
// `visitedDirs` is the "already seen" set; when a subdir is seen for the first
// time, it is queued in `pendingDirMds` so its CLAUDE.md is injected ONCE into
// history at the next turn boundary (ADR 0012 phase 1) — rather than being
// re-templated into the system prompt every turn, which made the prompt grow.
const visitedDirs = new Map(); // threadId → Set<absDir>
const pendingDirMds = new Map(); // threadId → absDir[] awaiting one-time CLAUDE.md injection

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

/**
 * Normalize provider-native usage into a stable {prompt,completion,total}
 * shape so the trace schema (and any downstream OTel exporter) does not
 * depend on OpenAI's `*_tokens` field names. Returns null when absent.
 */
function normalizeUsage(u) {
  if (!u || typeof u !== "object") return null;
  return {
    prompt: u.prompt_tokens ?? u.prompt ?? null,
    completion: u.completion_tokens ?? u.completion ?? null,
    total: u.total_tokens ?? u.total ?? null,
  };
}

// 20 was too tight for realistic multi-file tasks: a single edit_file
// mishap (e.g. indent mismatch) already costs several turns of retries,
// and legitimate refactors touch 5+ files. 40 gives honest headroom
// without letting a runaway loop burn forever.
const DEFAULT_MAX_TURNS = 40;

// ADR 0013: a no-slice Read of a file larger than this is redirected toward
// Grep/slicing instead of being dumped whole into context. Tunable.
const LARGE_READ_BYTES = 128 * 1024;

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

  // The LLM client is injectable so tests (ADR 0011 §4) can drive the loop
  // with scripted responses and no live endpoint. Defaults to the real client.
  const chatFn = ctx.chat || chat;

  const maxTurns = thread.agentDef?.maxTurns ?? profile.maxTurns ?? DEFAULT_MAX_TURNS;

  // Per-run telemetry accumulator, folded into the thread_end trace event.
  // Authoritative cross-run totals come from re-aggregating the trace file
  // (trace-stats.mjs, ADR 0011 §2); this is the cheap in-run view.
  const stats = { llmCalls: 0, toolCalls: 0, repairs: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  // Resume-card accumulators (feat/resume-card). The loop stamps a compact
  // `card` onto the thread meta it already rewrites at each pause/finish, so the
  // hooks read reuse-relevant spend as a plain meta field instead of folding
  // the trace on every render. Snapshot the prior card as the seed ONCE (the
  // per-turn meta refresh at the top of the loop reassigns thread.card, so
  // reading it live would double-count once this run persists its own card).
  //   turns/tokens  — accumulate ACROSS runs (seed + this run's delta)
  //   ctxTokens     — prompt size of the MOST RECENT llm_call: what a resume
  //                   re-sends, NOT a sum. Seeded so a run with no LLM call at
  //                   all keeps the last known value.
  const cardSeed = thread.card || {};
  let cardTask = cardSeed.task ?? null;
  let lastPromptTokens = cardSeed.ctxTokens ?? null;
  const buildCard = () => ({
    task: cardTask,
    turns: (cardSeed.turns || 0) + stats.llmCalls,
    tokens: (cardSeed.tokens || 0) + stats.totalTokens,
    ctxTokens: lastPromptTokens,
  });

  await threadMgr.setStatus(thread.id, ThreadStatus.RUNNING, { pending: null, error: null });

  // Emit a thread_start trace entry on the very first run. Subsequent resumes
  // skip this so the trace file has exactly one thread_start at the top.
  // Capture firstEverRun before flipping the flag: the loop restarts turn at 0
  // on every resume, so turn===0 alone is not enough to gate thread_start.
  const firstEverRun = !thread.traceStarted;
  if (firstEverRun) {
    await threadMgr.updateThread(thread.id, { traceStarted: true });
    Object.assign(thread, { traceStarted: true });
    // Logged after buildMessages so we have the initial system prompt — see
    // the turn_start emission inside the loop below (turn === 0 adds tools).
  }

  // Freeze the system prompt as a stable prefix (ADR 0012 phase 1): render it
  // once and reuse it verbatim every turn. This stops the prefix from growing
  // (visited-dir CLAUDE.md no longer goes here) and lets the inference server
  // reuse its KV cache across turns. Computed on first contact; threads created
  // before this feature get it lazily on their next run.
  if (!thread.systemPromptSnapshot) {
    const snapshot = await renderSystemPrompt({ thread, profile, registry, pluginRoot });
    await threadMgr.updateThread(thread.id, { systemPromptSnapshot: snapshot });
    Object.assign(thread, { systemPromptSnapshot: snapshot });
  }

  try {
    if (userMessage != null) {
      // Stamp the card's mission line exactly once — on the thread's FIRST-ever
      // user message (empty history). A seeded cardTask (from a prior run) or a
      // non-empty history means it is already set; later messages never
      // overwrite it. First non-empty line, capped at 100 chars.
      if (cardTask == null && (await threadMgr.readMessages(thread.id)).length === 0) {
        const firstLine = String(userMessage).split("\n").map((l) => l.trim()).find(Boolean);
        cardTask = firstLine ? firstLine.slice(0, 100) : null;
      }
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
        stats,
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
        turn,
        stats,
        getCard: buildCard,
      });
      if (leftover?.status === "awaiting_input") return leftover;

      // Inject top-of-turn context as a single synthetic user message:
      // one-time CLAUDE.md for newly-visited subdirs (ADR 0012) plus any
      // new mail addressed to this agent (ADR 0002). Combined into one
      // message so we never emit two consecutive user turns (which breaks
      // strict-alternation model templates). The inbox cursor is persisted
      // so a server restart does not re-deliver old mail.
      await drainTopOfTurnContext({ thread, threadMgr });
      // Re-read thread meta because the drain may have advanced inboxCursor.
      // buildMessages uses thread.id, not the stale ref, but other downstream
      // callers (dispatchToolCall, ctx) still carry the old `thread` object —
      // we refresh it once here.
      Object.assign(thread, (await threadMgr.getThread(thread.id)) || thread);

      const messages = await buildMessages({ thread, threadMgr, profile, registry, pluginRoot });
      const tools = registry.toOpenAISchema();

      // Emit a trace entry before each LLM call so we have a turn-by-turn
      // record of what the agent saw. Turn 0 also includes the tool list
      // (static for the life of the thread) to make the trace self-contained.
      if (firstEverRun && turn === 0) {
        appendTrace(thread, {
          type: "thread_start",
          turn,
          systemPrompt: messages[0].content,
          agent: agentNameFor(thread),
          model: profile.model,
          profile: profile.name ?? null,
          maxTurns,
          tools: registry.list().map((t) => ({ name: t.name, description: t.description })),
        });
      } else {
        appendTrace(thread, { type: "turn_start", turn });
      }

      const llmStart = Date.now();
      const { message, finishReason, usage } = await chatFn({
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
      const usageNorm = normalizeUsage(usage);
      stats.llmCalls += 1;
      if (usageNorm) {
        stats.promptTokens += usageNorm.prompt || 0;
        stats.completionTokens += usageNorm.completion || 0;
        stats.totalTokens += usageNorm.total || 0;
        // ctxTokens is the LATEST prompt size, not a running sum — it is what a
        // resume of this thread would re-send to the model.
        if (usageNorm.prompt != null) lastPromptTokens = usageNorm.prompt;
      }
      appendTrace(thread, {
        type: "llm_call",
        turn,
        latencyMs: Date.now() - llmStart,
        finishReason: finishReason ?? null,
        ...(usageNorm ? { usage: usageNorm } : {}),
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
        const finalContent = message.content || "";
        await threadMgr.setStatus(thread.id, ThreadStatus.IDLE, { pending: null, summary: summarize(finalContent), card: buildCard() });
        visitedDirs.delete(thread.id);
        pendingDirMds.delete(thread.id);
        publish(thread.cwd, {
          from: agentNameFor(thread), to: "parent", kind: "say", urgent: true,
          text: `[${thread.id}] Agent finished.\n${finalContent}`,
        }).catch(() => {});
        appendTrace(thread, { type: "thread_end", reason: "final", turns: turn + 1, totals: { ...stats } });
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
          turn,
          stats,
          getCard: buildCard,
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
    await threadMgr.setStatus(thread.id, ThreadStatus.IDLE, { pending: null, summary: `reached turn limit (${maxTurns})`, card: buildCard() });
    visitedDirs.delete(thread.id);
    pendingDirMds.delete(thread.id);
    publish(thread.cwd, {
      from: agentNameFor(thread), to: "parent", kind: "say", urgent: true,
      text: `[${thread.id}] Agent reached turn limit (${maxTurns}). Work so far is persisted — send a follow-up to continue.`,
    }).catch(() => {});
    appendTrace(thread, { type: "thread_end", reason: "max_turns", turns: maxTurns, totals: { ...stats } });
    return { status: "max_turns", content: `reached max_turns (${maxTurns})` };
  } catch (err) {
    // If the loop was aborted intentionally (agent_stop), the status is
    // already set to STOPPED — don't overwrite it with ERROR.
    visitedDirs.delete(thread.id);
    pendingDirMds.delete(thread.id);
    if (signal?.aborted) {
      appendTrace(thread, { type: "thread_end", reason: "stopped", totals: { ...stats } });
      return { status: "stopped" };
    }
    await threadMgr.setStatus(thread.id, ThreadStatus.ERROR, {
      error: { message: err.message, stack: err.stack },
      pending: null,
      card: buildCard(),
    });
    publish(thread.cwd, {
      from: agentNameFor(thread), to: "parent", kind: "error", urgent: true,
      text: `[${thread.id}] Agent error: ${err.message}`,
    }).catch(() => {});
    appendTrace(thread, { type: "thread_end", reason: "error", error: err.message, totals: { ...stats } });
    throw err;
  }
}

/**
 * After a resume (or defensively, at the start of each turn), inspect
 * the most recent assistant message. If it had multiple tool_calls and
 * only some were answered, process the unanswered ones in order. If one
 * triggers a pause, surface it. If all are answered, this is a no-op.
 */
async function drainLeftoverToolCalls({ thread, threadMgr, sandbox, registry, pluginRoot, turn, stats, getCard }) {
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
      turn,
      stats,
      getCard,
    });
    if (outcome.status === "awaiting_input") return outcome;
  }
  return null;
}

/**
 * Inject top-of-turn context as a SINGLE synthetic user message, combining two
 * sources so we never emit two consecutive user turns (which breaks strict
 * alternation):
 *
 *  1. One-time CLAUDE.md for subdirectories the agent has just started working
 *     in (ADR 0012 phase 1). Queued in `pendingDirMds` by the file tools and
 *     drained here exactly once, so it never bloats the frozen system prefix.
 *  2. New mail from messages.jsonl addressed to this agent (ADR 0002). The
 *     inbox cursor advances to the last *observed* id (not just delivered ones)
 *     so unrelated workspace traffic is not re-scanned every turn.
 */
async function drainTopOfTurnContext({ thread, threadMgr }) {
  const sections = [];

  // (1) one-time CLAUDE.md for newly-visited subdirs
  const pend = pendingDirMds.get(thread.id);
  if (pend && pend.length > 0) {
    const dirs = pend.splice(0); // consume the queue
    const blocks = [];
    for (const dir of dirs) {
      try {
        const content = (await readFile(resolve(dir, "CLAUDE.md"), "utf8")).trim();
        if (content) blocks.push(content);
      } catch {
        // no CLAUDE.md in this directory — nothing to inject
      }
    }
    if (blocks.length > 0) {
      sections.push(
        `Project context for directories you just accessed:\n\n${blocks.join("\n\n---\n\n")}`,
      );
    }
  }

  // (2) new mail addressed to this agent
  const cursor = thread.inboxCursor || null;
  const all = await readMessagesSince(thread.cwd, cursor);
  if (all.length > 0) {
    const self = agentNameFor(thread);
    const delivered = all.filter((m) => addressedTo(m, self) && m.from !== self);
    if (delivered.length > 0) {
      const body = delivered
        .map((m) => {
          const ref = m.ref ? ` (re: ${m.ref})` : "";
          const urgent = m.urgent ? " [URGENT]" : "";
          const item = m.item_id ? ` [item=${m.item_id}]` : "";
          return `- ${m.id} ${m.from} → ${JSON.stringify(m.to)} ${m.kind}${urgent}${item}${ref}: ${m.text}`;
        })
        .join("\n");
      sections.push(`Inbox update — ${delivered.length} new message(s) since your last turn:\n${body}`);
    }
    await threadMgr.updateThread(thread.id, { inboxCursor: all[all.length - 1].id });
  }

  if (sections.length > 0) {
    await threadMgr.appendMessage(thread.id, { role: "user", content: sections.join("\n\n") });
  }
}

async function buildMessages({ thread, threadMgr, profile, registry, pluginRoot }) {
  const messages = [];

  // The system prompt is a frozen, stable prefix (ADR 0012 phase 1): reuse the
  // snapshot taken on the thread's first run so it is byte-identical every turn
  // (stops the prefix growing, lets the server reuse its KV cache). Render on
  // the fly only as a fallback — a thread predating the snapshot, or a direct
  // unit-test call to buildMessages.
  const system =
    thread.systemPromptSnapshot ||
    (await renderSystemPrompt({ thread, profile, registry, pluginRoot }));
  messages.push({ role: "system", content: system });

  const history = await threadMgr.readMessages(thread.id);
  for (const m of history) {
    const { ts, ...rest } = m;
    messages.push(rest);
  }
  return messages;
}

/**
 * Render the layered system prompt (ADR 0003/0006). Called ONCE per thread to
 * produce the frozen prefix that buildMessages then reuses. Layers: sandbox
 * framing + cwd CLAUDE.md + tool restrictions + skill catalog + agent body.
 * It deliberately does NOT include visited-subdir CLAUDE.md — those are
 * injected once into history as the agent visits them (ADR 0012 phase 1), so
 * this prefix never grows turn over turn.
 */
async function renderSystemPrompt({ thread, profile, registry, pluginRoot }) {
  if (!thread.agentDef) {
    return profile.systemPrompt || thread.systemPrompt || defaultSystemPrompt(thread);
  }

  const effectivePolicy = buildToolPolicy(
    thread.agentDef,
    registry.list().map((t) => t.name),
  );

  const parts = [defaultSystemPrompt(thread)];

  // Startup CLAUDE.md: cwd only. Subdirectory CLAUDE.md is injected once into
  // history as the agent works there, never baked into this frozen prefix.
  const claudeMds = await collectClaudeMds(thread.cwd);
  if (claudeMds.length > 0) {
    parts.push(claudeMds.map(({ content }) => content).join("\n\n---\n\n"));
  }

  const toolNote = buildToolRestrictionsNote(effectivePolicy);
  if (toolNote) parts.push(toolNote);

  const skillFilter = Array.isArray(thread.agentDef.skills) ? thread.agentDef.skills : null;
  const catalog = await buildSkillCatalog(thread.cwd, skillFilter, pluginRoot);
  if (catalog.length > 0) parts.push(SKILLS_HEADER + "\n" + catalog.join("\n"));

  // Agent body lives in the system prompt (putting it in a user message would
  // create consecutive user turns on turn 0 and break strict-alternation
  // model templates like Mistral's).
  if (thread.agentDef.prompt) parts.push(thread.agentDef.prompt);
  else if (thread.agentDef.body) parts.push(thread.agentDef.body);

  return parts.join("\n\n");
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
/**
 * ADR 0013 — tool workflow discipline. The harness keeps the model on the
 * rails: it checks a tool call against two rules and, on a violation, returns
 * a corrective string (the caller injects it as the tool result instead of
 * running the tool). Returns null when the call may proceed.
 *
 *   Read → Write/Edit: never modify an existing file not in the thread's
 *                      known set (read it first — no blind clobbering).
 *   Grep → Read:       redirect a full read of a large file toward locating
 *                      with Grep or reading a slice.
 */
function checkWorkflowDiscipline({ name, args, thread, sandbox }) {
  const known = Array.isArray(thread.knownFiles) ? thread.knownFiles : [];

  if (name === "Write" || name === "Edit") {
    let abs;
    try { abs = sandbox.resolvePath(args?.path); } catch { return null; }
    // New file (does not exist yet) needs no prior read; only existing
    // content must be read before it is mutated.
    if (existsSync(abs) && !known.includes(abs)) {
      return `Workflow: you have not read '${args.path}' in this thread. Read it first so you don't overwrite content you haven't seen, then retry the ${name}.`;
    }
    return null;
  }

  if (name === "Read") {
    const hasSlice = args && (args.start_line != null || args.end_line != null);
    if (hasSlice) return null;
    let abs;
    try { abs = sandbox.resolvePath(args?.path); } catch { return null; }
    if (!existsSync(abs)) return null;
    let size = 0;
    try { size = statSync(abs).size; } catch { return null; }
    if (size > LARGE_READ_BYTES) {
      return `Workflow: '${args.path}' is large (${size} bytes). Use Grep to locate what you need, or Read with start_line/end_line to read only the relevant slice, instead of reading the whole file.`;
    }
    return null;
  }

  return null;
}

/**
 * Record a file as "known" to the agent after a successful Read/Write/Edit
 * (ADR 0013). Persisted on thread meta and mirrored onto the in-memory thread
 * object so later tool calls in the same turn see it immediately.
 */
async function recordKnownFile({ tool, args, sandbox, thread, threadMgr }) {
  if (!args?.path) return;
  if (tool.name !== "Read" && tool.name !== "Write" && tool.name !== "Edit") return;
  let abs;
  try { abs = sandbox.resolvePath(args.path); } catch { return; }
  const known = Array.isArray(thread.knownFiles) ? thread.knownFiles : [];
  if (known.includes(abs)) return;
  const next = [...known, abs];
  await threadMgr.updateThread(thread.id, { knownFiles: next });
  thread.knownFiles = next;
}

async function dispatchToolCall({ call, sandbox, registry, thread, threadMgr, pluginRoot, turn, stats, getCard }) {
  const name = call?.function?.name;
  const toolCallId = call?.id || `call_${Date.now()}`;
  const tool = registry.get(name);

  if (!tool) {
    await appendToolResult(threadMgr, thread.id, toolCallId, `Error: unknown tool '${name}'`);
    appendTrace(thread, { type: "tool_call", turn: turn ?? null, name, outcome: "error" });
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
      if (stats) stats.repairs += 1;
      appendTrace(thread, { type: "repair", turn: turn ?? null, tool: name, recovered: true });
    } catch (err) {
      appendTrace(thread, { type: "repair", turn: turn ?? null, tool: name, recovered: false });
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
    await threadMgr.setStatus(thread.id, ThreadStatus.AWAITING_INPUT, { pending, summary: `asked: ${String(args.question).slice(0, 120)}`, ...(getCard ? { card: getCard() } : {}) });
    appendTrace(thread, { type: "pause", turn: turn ?? null, kind: "question" });
    publish(thread.cwd, {
      from: agentNameFor(thread), to: "parent", kind: "question", urgent: true,
      text: `[${thread.id}] Agent paused — waiting for answer.\nQuestion: ${args.question}`,
    }).catch(() => {});
    return { status: "awaiting_input", pending };
  }

  // ADR 0013: harness workflow discipline. Intercept a violating call before
  // it runs (and before any approval pause) and feed back a corrective prompt.
  const correction = checkWorkflowDiscipline({ name, args, thread, sandbox });
  if (correction) {
    await appendToolResult(threadMgr, thread.id, toolCallId, correction);
    appendTrace(thread, { type: "tool_call", turn: turn ?? null, name, outcome: "blocked" });
    return { status: "ok" };
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
      return runToolAndAppend({ tool, args, toolCallId, sandbox, thread, threadMgr, pluginRoot, turn, stats });
    }
    if (sc.sessionDeny?.includes(command)) {
      await appendToolResult(threadMgr, thread.id, toolCallId, `Error: command '${command}' is denied.`);
      appendTrace(thread, { type: "tool_call", turn: turn ?? null, name, outcome: "denied" });
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
    appendTrace(thread, { type: "tool_call", turn: turn ?? null, name, outcome: "denied" });
    return { status: "ok" };
  }

  // Ask → pause for approval
  if (decision === Decision.ASK) {
    const pending = { toolCallId, kind: "approval", name, args };
    await threadMgr.setStatus(thread.id, ThreadStatus.AWAITING_INPUT, { pending, summary: `needs approval: ${name}`, ...(getCard ? { card: getCard() } : {}) });
    appendTrace(thread, { type: "pause", turn: turn ?? null, kind: "approval", tool: name });
    const argsPreview = JSON.stringify(args).slice(0, 120);
    publish(thread.cwd, {
      from: agentNameFor(thread), to: "parent", kind: "question", urgent: true,
      text: `[${thread.id}] Agent paused — approval needed for tool **${name}**.\nArgs: ${argsPreview}\nCall \`thread_approve\` to allow or deny.`,
    }).catch(() => {});
    return { status: "awaiting_input", pending };
  }

  return runToolAndAppend({ tool, args, toolCallId, sandbox, thread, threadMgr, pluginRoot, turn, stats });
}

async function runToolAndAppend({ tool, args, toolCallId, sandbox, thread, threadMgr, pluginRoot, turn, stats }) {
  const started = Date.now();
  try {
    const result = await tool.run(args, { sandbox, thread, threadMgr, pluginRoot, agentName: agentNameFor(thread), signal: activeSignal });
    const raw = typeof result?.content === "string" ? result.content : JSON.stringify(result);
    const content = sanitizeForModel(raw, sandbox.getRoot());
    await appendToolResult(threadMgr, thread.id, toolCallId, content);
    if (stats) stats.toolCalls += 1;
    appendTrace(thread, { type: "tool_call", turn: turn ?? null, name: tool.name, latencyMs: Date.now() - started, outcome: "ok" });
    // ADR 0013: remember files the agent has now seen.
    await recordKnownFile({ tool, args, sandbox, thread, threadMgr });
    // Track subdirectories touched by file tools. The first time we see a
    // subdir (strictly below cwd — the cwd CLAUDE.md is already in the frozen
    // prefix), queue it so its CLAUDE.md is injected ONCE into history at the
    // next turn boundary (ADR 0012 phase 1), instead of re-templating it into
    // the system prompt every turn.
    if (args.path && (tool.name === "Read" || tool.name === "Write" || tool.name === "Edit")) {
      const abs = args.path.startsWith("/") ? args.path : resolve(thread.cwd, args.path);
      const dir = dirname(abs);
      if (dir.startsWith(thread.cwd + "/")) {
        if (!visitedDirs.has(thread.id)) visitedDirs.set(thread.id, new Set());
        const seen = visitedDirs.get(thread.id);
        if (!seen.has(dir)) {
          seen.add(dir);
          if (!pendingDirMds.has(thread.id)) pendingDirMds.set(thread.id, []);
          pendingDirMds.get(thread.id).push(dir);
        }
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
    if (stats) stats.toolCalls += 1;
    appendTrace(thread, { type: "tool_call", turn: turn ?? null, name: tool.name, latencyMs: Date.now() - started, outcome: "error" });
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
async function resolvePending({ thread, threadMgr, sandbox, registry, resume, pluginRoot, stats }) {
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
    appendTrace(thread, { type: "tool_call", turn: null, name: pending.name, outcome: "denied" });
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

  const started = Date.now();
  try {
    const result = await tool.run(pending.args, { sandbox, thread, threadMgr, pluginRoot, agentName: agentNameFor(thread), signal: activeSignal });
    const raw = typeof result?.content === "string" ? result.content : JSON.stringify(result);
    const content = sanitizeForModel(raw, sandbox.getRoot());
    await appendToolResult(threadMgr, thread.id, pending.toolCallId, content);
    if (stats) stats.toolCalls += 1;
    appendTrace(thread, { type: "tool_call", turn: null, name: pending.name, latencyMs: Date.now() - started, outcome: "ok" });
    await recordKnownFile({ tool, args: pending.args, sandbox, thread, threadMgr });
  } catch (err) {
    const msg = sanitizeForModel(err.message || String(err), sandbox.getRoot());
    await appendToolResult(
      threadMgr,
      thread.id,
      pending.toolCallId,
      `Error: ${pending.name} failed: ${msg}`,
    );
    if (stats) stats.toolCalls += 1;
    appendTrace(thread, { type: "tool_call", turn: null, name: pending.name, latencyMs: Date.now() - started, outcome: "error" });
  }
  await threadMgr.setStatus(thread.id, ThreadStatus.RUNNING, { pending: null });
  return { status: "ok" };
}
