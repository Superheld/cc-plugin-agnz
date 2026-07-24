// Repetition guard: catch an agent that is circling one file instead of
// making progress.
//
// Field evidence (dashboard project, 21 threads): 6 of 21 runs died on the
// 40-turn limit, and every one of them shows the same signature — many calls,
// few distinct ones, all aimed at a single file. dash-jsfix3 spent ~24
// consecutive tool calls on frontend/js/main.js, re-reading overlapping slices
// of the same 30 lines between blind edits; dash-jsfix tiled the same 90 lines
// in shifting windows. Neither ever converged, and the harness had no signal
// for it: the ADR 0013 dedup only knows full-file re-reads, so a wandering
// slice window is invisible to it.
//
// Two stages, deliberately ordered cheapest-first:
//
//   1. Coverage dedup — a slice the agent has already seen, on a file that has
//      not changed, is answered with a pointer instead of the bytes.
//   2. Focus escalation — N consecutive calls against the same path earn one
//      corrective; if it keeps going, the thread pauses and asks the LEAD for
//      a different strategy (agnz's AskUser addresses the parent, not the
//      human — the run resumes via `agnz answer`).
//
// Stage 2 exists because stage 1 cannot carry the load on its own: in the
// observed runs almost every re-read follows an Edit, which legitimately
// invalidates what the agent knew. Counting focus needs no such bookkeeping.

/** Consecutive calls on one path before the agent gets a corrective. */
export const NUDGE_AT = 8;
/** Consecutive calls before the thread pauses and asks the lead. */
export const ASK_AT = 16;

// Stand-in for "to the end of the file" — a full read covers every line, but
// the harness never learns the line count. MAX_SAFE_INTEGER keeps the value
// JSON-serialisable for the thread meta.
const END = Number.MAX_SAFE_INTEGER;

// --- stage 1: line-range bookkeeping ---------------------------------------

/**
 * Merge [start, end] into a sorted, non-overlapping interval list.
 * Adjacent intervals are coalesced so a file read in consecutive slices ends
 * up as one range rather than a growing list of fragments.
 */
export function mergeRange(ranges, start, end) {
  const all = [...(Array.isArray(ranges) ? ranges : []), [start, end]]
    .filter((r) => Array.isArray(r) && r.length === 2)
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of all) {
    const last = out[out.length - 1];
    // `s <= last[1] + 1` coalesces touching ranges (10-20 then 21-30).
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** True when [start, end] lies entirely inside an already-read range. */
export function coveredBy(ranges, start, end) {
  if (!Array.isArray(ranges)) return false;
  return ranges.some(([s, e]) => s <= start && e >= end);
}

/** The whole-file range, for a full Read or an authored Write. */
export function fullRange() {
  return [[1, END]];
}

/**
 * Resolve a Read's arguments to a concrete [start, end] pair.
 * An open end (start_line without end_line) reads to EOF.
 */
export function readRange(args) {
  const start = Math.max(1, args?.start_line ?? 1);
  const end = args?.end_line ?? END;
  return end < start ? [start, start] : [start, end];
}

/** Human-readable range, for the dedup message. */
export function fmtRange([start, end]) {
  return end >= END ? `${start}-end` : `${start}-${end}`;
}

// --- stage 2: focus tracking -----------------------------------------------

/**
 * Advance the consecutive-same-path counter.
 *
 * A different path resets it: an agent that moves between files is working,
 * not circling. Edits deliberately do NOT reset it — the observed pathology
 * interleaves edits with re-reads, so treating a mutation as progress would
 * blind the guard to exactly the case it exists for.
 *
 * @param {object|null} focus — previous state from thread meta
 * @param {string} path — resolved absolute path of the current call
 * @returns {{path: string, count: number, nudged: boolean}}
 */
export function trackFocus(focus, path) {
  if (focus && focus.path === path) {
    return { path, count: (focus.count || 0) + 1, nudged: focus.nudged === true };
  }
  return { path, count: 1, nudged: false };
}

/**
 * What to do at this focus level: "quiet", "nudge" (once) or "ask".
 * The nudge fires only once per streak so a blocked call cannot deadlock the
 * agent — after the corrective it may keep working until the ask threshold.
 */
export function focusVerdict(focus) {
  if (!focus) return "quiet";
  if (focus.count >= ASK_AT) return "ask";
  if (focus.count >= NUDGE_AT && !focus.nudged) return "nudge";
  return "quiet";
}

/** Corrective injected in place of the blocked call at NUDGE_AT. */
export function focusNudge(focus, displayPath) {
  return (
    `Workflow: this is call ${focus.count} in a row against '${displayPath}' — ` +
    `you are circling rather than converging. This call was not run.\n` +
    `State plainly what you still need to determine, then change approach. ` +
    `Re-reading the same region again will not reveal it: use a command that ` +
    `answers the question directly (a syntax check, a test, a targeted Grep ` +
    `across the file), or widen your view instead of narrowing it further.`
  );
}

/**
 * Question put to the LEAD when the agent keeps circling past ASK_AT.
 * Carries the evidence so the lead can decide without opening the transcript
 * (ADR 0019: every non-quiet signal states evidence and a next action).
 */
export function focusQuestion(focus, displayPath) {
  return (
    `I have made ${focus.count} consecutive tool calls against '${displayPath}' ` +
    `without resolving the task, and a corrective did not break the pattern. ` +
    `I am stuck and would rather ask than burn the remaining turns.\n` +
    `How should I proceed — is there a different approach, a command I should ` +
    `run, or information about this file I am missing?`
  );
}
