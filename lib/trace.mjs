// Append-only runtime trace for agent threads.
//
// Written to <cwd>/.claude/agnz/threads/<thread-id>.trace.jsonl
// alongside the existing .meta.json and .jsonl (transcript).
//
// Entry types (ADR 0011 — every entry is OpenTelemetry-span-mappable:
// `ts` is the span start, `latencyMs` the duration, `outcome`/`reason` the
// status, and the type doubles as the span name):
//   thread_start  — emitted once on the very first run: tools, model, agent,
//                   profile + initial system prompt
//   turn_start    — before every LLM API call: current system prompt
//   llm_call      — around each chat(): latencyMs, finishReason, usage
//   tool_call     — around each tool dispatch: name, latencyMs, outcome
//                   (ok|error|denied)
//   repair        — JSON-argument repair fired: tool, recovered (bool)
//   pause         — approval/question pause: kind, tool
//   thread_end    — terminal state: reason (final|max_turns|error|stopped),
//                   turns, totals
//
// This gives a complete chronological picture of what the agent knew and
// how its working-memory evolved across turns.

import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Append a single trace entry. All entries get a `ts` timestamp automatically.
 * Failures are always silent — tracing must never crash the agent loop.
 */
export async function appendTrace(thread, entry) {
  try {
    const dir = resolve(thread.cwd, ".claude", "agnz", "threads");
    const file = resolve(dir, `${thread.id}.trace.jsonl`);
    await appendFile(file, JSON.stringify({ ts: Date.now(), ...entry }) + "\n", "utf8");
  } catch {
    // intentionally silent
  }
}
