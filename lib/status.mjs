// The judgment layer of the lead dashboard (ADR 0019 §1–§2).
//
// Pure functions over what is already on disk (thread meta + trace events):
// nothing here does I/O, so every verdict is unit-testable and every surface
// (CLI `show`, the CC hooks, future renderers) can share the same brain.
//
// The core idea: `status` is fact (the thread lifecycle enum), `verdict` is
// interpretation — the diagnosis the lead otherwise improvises by diffing
// timestamps across prompts ("no completed tool call for 20 minutes, that's
// far outside normal"). Thresholds self-calibrate against the thread's OWN
// trace (median LLM latency) so a 2 tok/s model and a 20 tok/s model are each
// judged against themselves; a hard floor covers threads with no history.

// An in-flight LLM call is judged hung at 10× the thread's median call
// latency, but never sooner than this floor — cold threads (no median yet)
// use the floor alone. Field incidents so far: 43 min at ~2.4 min median
// (18×) and 22 min at similar — both far past either bound.
export const HUNG_FLOOR_MS = 10 * 60 * 1000;
export const HUNG_MEDIAN_FACTOR = 10;
export const SLOW_MEDIAN_FACTOR = 3;
// Idle threads older than this collapse into the stale bucket (matches the
// hooks' existing STALE_MS).
export const STALE_MS = 24 * 60 * 60 * 1000;

/**
 * What is the thread doing RIGHT NOW, per its trace? The loop appends
 * `turn_start` before each LLM call and `llm_call` after it returns, so a
 * trailing `turn_start`/`thread_start` without a following `llm_call` IS an
 * in-flight LLM call, in flight since that entry's ts.
 *
 * Returns { llmInFlightMs, medianLlmMs } — either may be null (no call in
 * flight / no completed calls to calibrate against).
 */
export function deriveInFlight(entries, now = Date.now()) {
  let llmInFlightMs = null;
  const latencies = [];
  let pendingStartTs = null;
  for (const e of entries || []) {
    if (e.type === "turn_start" || e.type === "thread_start") {
      pendingStartTs = e.ts ?? null;
    } else if (e.type === "llm_call") {
      pendingStartTs = null;
      if (typeof e.latencyMs === "number") latencies.push(e.latencyMs);
    }
  }
  if (pendingStartTs != null) llmInFlightMs = Math.max(0, now - pendingStartTs);
  latencies.sort((a, b) => a - b);
  const medianLlmMs = latencies.length
    ? latencies[Math.floor((latencies.length - 1) / 2)]
    : null;
  return { llmInFlightMs, medianLlmMs };
}

/**
 * Judge one thread. Input is plain data (meta + trace entries), output is the
 * glossary triple: { verdict, evidence, action } — evidence and action may be
 * null for quiet verdicts. `addr` (name or short id) is what action strings
 * are typed with.
 */
export function judgeThread({ thread, entries = [], now = Date.now() }) {
  const addr = thread.name || (thread.id ? thread.id.slice(0, 8) : "?");

  if (thread.status === "error") {
    return {
      verdict: "error",
      evidence: thread.error?.message || null,
      action: `agnz remove ${addr} (dead — start fresh)`,
    };
  }

  if (thread.status === "awaiting_input") {
    const kind = thread.pending?.kind;
    if (kind === "question") {
      return {
        verdict: "awaiting-answer",
        evidence: thread.pending?.question ? String(thread.pending.question).slice(0, 140) : null,
        action: `agnz answer ${addr} "..."`,
      };
    }
    return {
      verdict: "awaiting-approval",
      evidence: thread.pending?.name ? `tool: ${thread.pending.name}` : null,
      action: `agnz approve ${addr} allow|deny`,
    };
  }

  if (thread.status === "running") {
    const { llmInFlightMs, medianLlmMs } = deriveInFlight(entries, now);
    if (llmInFlightMs != null) {
      const hungAt = Math.max(HUNG_FLOOR_MS, medianLlmMs != null ? HUNG_MEDIAN_FACTOR * medianLlmMs : 0);
      const medianNote = medianLlmMs != null ? `median ${fmtDur(medianLlmMs)}` : "no median yet";
      if (llmInFlightMs >= hungAt) {
        return {
          verdict: "hung",
          evidence: `LLM call running ${fmtDur(llmInFlightMs)} (${medianNote})`,
          action: `agnz interrupt ${addr}`,
        };
      }
      if (medianLlmMs != null && llmInFlightMs >= SLOW_MEDIAN_FACTOR * medianLlmMs) {
        return {
          verdict: "slow",
          evidence: `LLM call running ${fmtDur(llmInFlightMs)} (${medianNote})`,
          action: null, // watch, don't page (ADR 0019 open question: slow stays quiet in the block)
        };
      }
    }
    return { verdict: "working", evidence: null, action: null };
  }

  if (thread.status === "idle") {
    const age = now - (thread.updatedAt || now);
    if (age >= STALE_MS) {
      return { verdict: "stale", evidence: `idle ${fmtDur(age)}`, action: `agnz stop ${addr} (done?) or agnz send ${addr} "..."` };
    }
    return { verdict: "done", evidence: null, action: null };
  }

  return { verdict: thread.status || "unknown", evidence: null, action: null };
}

/** One duration rendering everywhere (glossary `since`): 40s / 22m / 3h / 2d. */
export function fmtDur(ms) {
  if (ms == null || !Number.isFinite(ms)) return "?";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
