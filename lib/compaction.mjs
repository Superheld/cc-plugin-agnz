// Context compaction (context-diet 3/3, extends ADR 0012).
//
// The transcript is append-only and re-sent whole every turn, which keeps the
// inference server's prefix cache warm — mutating old messages would invalidate
// it, so we never do that in the steady state. Instead, when the context
// approaches the model's window (default 90%), the run pays ONE deliberate
// reset: the model summarizes its own session (from a ballast-stripped copy of
// the history — the stripping happens only in that one-shot input, never in the
// live transcript), the summary is appended as a marker message, and from then
// on buildMessages sends system prompt + everything from the marker. The full
// history stays on disk; correctness is unaffected because it is enforced at
// apply time (Edit anchor match, read-before-write), not by what the context
// remembers — the knowledge state (knownFiles/fileStamps/visitedDirs) is
// cleared at the reset so those gates force re-reads instead of attesting to
// knowledge that is no longer in context.
//
// Opt-in: fires only when the profile declares `contextWindow` (the
// OpenAI-compatible API does not expose it, so the user states it once).

import { appendTrace } from "./trace.mjs";

// Caps for the summarizer's input — generous for messages the agent needs to
// see whole (its own reasoning, the task), tight for tool payloads (the exact
// ballast the compaction exists to shed).
const CAP_TEXT = 4000; // user/assistant message content
const CAP_TOOL = 600; // tool results and tool-call argument strings

export const COMPACTION_PROMPT = `You produced the conversation in the next message while working as a coding agent. Your context window is nearly full, so that history will be replaced by a summary you write now. Write a compact handoff to yourself covering:

1. The task you were given.
2. What you have done so far — every file you created or modified, by path, with a one-line note of what changed.
3. Key decisions, constraints, and facts you discovered that you still need.
4. What remains to be done, precisely, as next steps.

Do not quote file contents — files live on disk and you can re-read them. Reply with the summary only.`;

/**
 * Should this turn compact? True only when the profile declares a context
 * window and the last observed prompt size crossed the threshold. A server
 * that reports no usage never triggers this (lastPromptTokens stays null).
 */
export function shouldCompact({ lastPromptTokens, profile }) {
  const win = profile?.contextWindow;
  if (typeof win !== "number" || win <= 0) return false;
  if (typeof lastPromptTokens !== "number" || lastPromptTokens <= 0) return false;
  const raw = typeof profile.compactThreshold === "number" ? profile.compactThreshold : 0.9;
  const threshold = Math.min(Math.max(raw, 0.1), 0.99);
  return lastPromptTokens >= threshold * win;
}

function cap(text, limit) {
  const s = typeof text === "string" ? text : "";
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}\n… [+${s.length - limit} more chars]`;
}

// One tool call, argument-stubbed when large. Write/Edit arguments are the
// measured heavyweight (the agent carries every file it wrote as ballast), so
// they collapse to path + size; the path alone is what the summary needs.
function renderToolCall(tc) {
  const name = tc?.function?.name || "?";
  const argsStr = tc?.function?.arguments || "";
  if (argsStr.length <= CAP_TOOL) return `→ ${name}(${argsStr})`;
  let path = null;
  try {
    path = JSON.parse(argsStr)?.path ?? null;
  } catch {
    /* unparseable args: fall through to the generic stub */
  }
  const where = path ? `path: ${JSON.stringify(path)}, ` : "";
  return `→ ${name}({${where}args elided — ${argsStr.length} chars})`;
}

/**
 * Render the history (from the last compaction marker, if any) as plain text
 * for the summarizer. Pure — the live transcript is never touched.
 */
export function renderCompactionInput(history) {
  let start = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?._compact) {
      start = i;
      break;
    }
  }
  const lines = [];
  for (const m of history.slice(start)) {
    if (m._compact) {
      // The prior summary is dense context, not ballast — keep it whole.
      lines.push(`[earlier summary — from a previous compaction]\n${m.content || ""}`);
    } else if (m.role === "user") {
      lines.push(`[user]\n${cap(m.content, CAP_TEXT)}`);
    } else if (m.role === "assistant") {
      const parts = [];
      if (m.content) parts.push(cap(m.content, CAP_TEXT));
      for (const tc of m.tool_calls || []) parts.push(renderToolCall(tc));
      lines.push(`[assistant]\n${parts.join("\n")}`);
    } else if (m.role === "tool") {
      lines.push(`[tool result]\n${cap(m.content, CAP_TOOL)}`);
    }
  }
  return lines.join("\n\n");
}

/**
 * The marker is a regular user-role message in the transcript (append-only —
 * nothing before it is rewritten). buildMessages recognises `_compact` and
 * starts the wire payload from the newest one.
 */
export function buildCompactionMarker(summary) {
  return {
    role: "user",
    _compact: true,
    content:
      "[Context compacted: the conversation so far was replaced by the summary below. " +
      "The full history is preserved on disk. Files you had read earlier are no longer " +
      "in your context — Read them again before you rely on or edit their content.]\n\n" +
      summary +
      "\n\nContinue the task from here.",
  };
}

/**
 * Run one compaction: summarize, append the marker, clear the thread's
 * knowledge state. Returns true on success. Failure is contained — traced,
 * never thrown — so a broken summarize call degrades to "no compaction",
 * not a dead run.
 */
export async function performCompaction({ thread, threadMgr, profile, chatFn, turn, signal }) {
  const started = Date.now();
  try {
    const history = await threadMgr.readMessages(thread.id);
    const input = renderCompactionInput(history);
    const { message } = await chatFn({
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      model: profile.model,
      messages: [
        { role: "system", content: COMPACTION_PROMPT },
        { role: "user", content: input },
      ],
      temperature: 0.2,
      maxTokens: profile.maxTokens,
      ...(profile.llmTimeoutMs != null ? { timeoutMs: profile.llmTimeoutMs } : {}),
      signal,
    });
    const summary = typeof message?.content === "string" ? message.content.trim() : "";
    if (!summary) throw new Error("model returned an empty summary");

    await threadMgr.appendMessage(thread.id, buildCompactionMarker(summary));
    // Reset the knowledge state: its claims ("already read", "already
    // injected") are about a context that just ceased to exist. The ADR 0013
    // gates now force fresh reads, and revisited dirs re-inject their
    // CLAUDE.md.
    const reset = { knownFiles: [], fileStamps: {}, visitedDirs: [], pendingDirMds: [] };
    await threadMgr.updateThread(thread.id, reset);
    Object.assign(thread, reset);

    appendTrace(thread, {
      type: "compaction",
      turn: turn ?? null,
      latencyMs: Date.now() - started,
      inputChars: input.length,
      summaryChars: summary.length,
      outcome: "ok",
    });
    return true;
  } catch (err) {
    appendTrace(thread, {
      type: "compaction",
      turn: turn ?? null,
      latencyMs: Date.now() - started,
      outcome: "error",
      error: err?.message || String(err),
    });
    return false;
  }
}
