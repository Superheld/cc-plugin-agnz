// Pure scoring + scorecard rendering for the agnz eval harness (ADR 0011 §5).
//
// Kept free of IO so it is unit-testable without a live model. run.mjs feeds
// it raw per-(fixture × profile) results; this folds them into a per-profile
// scorecard and renders a table. The "quality" metrics (turns, tokens,
// tool-error rate, repair rate) come from the ADR 0011 trace, so a model that
// passes but flails (many repairs, many turns) is visibly worse than one that
// passes cleanly.

/**
 * @typedef {Object} EvalResult
 * @property {string} fixture
 * @property {string} profile
 * @property {boolean} pass
 * @property {string} status   - loop outcome: final | max_turns | paused | error
 * @property {string} detail   - assertion detail
 * @property {{turns:number, tokens:number, toolCalls:number, toolErrors:number, repairs:number, durationMs:number}} metrics
 */

/** Fold raw results into per-profile aggregates + an overall pass count. */
export function buildScorecard(results) {
  const byProfile = new Map();
  for (const r of results) {
    let p = byProfile.get(r.profile);
    if (!p) {
      p = {
        profile: r.profile,
        total: 0,
        passed: 0,
        turns: 0,
        tokens: 0,
        toolCalls: 0,
        toolErrors: 0,
        repairs: 0,
        durationMs: 0,
      };
      byProfile.set(r.profile, p);
    }
    p.total += 1;
    if (r.pass) p.passed += 1;
    p.turns += r.metrics.turns;
    p.tokens += r.metrics.tokens;
    p.toolCalls += r.metrics.toolCalls;
    p.toolErrors += r.metrics.toolErrors;
    p.repairs += r.metrics.repairs;
    p.durationMs += r.metrics.durationMs;
  }

  const profiles = [...byProfile.values()].map((p) => ({
    ...p,
    passRate: p.total ? p.passed / p.total : 0,
    // tool-error and repair *rates* normalize over tool/llm activity so they
    // compare fairly across fixtures of different sizes.
    toolErrorRate: p.toolCalls ? p.toolErrors / p.toolCalls : 0,
    repairRate: p.turns ? p.repairs / p.turns : 0,
  }));
  // Rank: most passes first, then fewer tokens (cheaper) as the tiebreak.
  profiles.sort((a, b) => b.passRate - a.passRate || a.tokens - b.tokens);

  return { results, profiles };
}

function pct(x) {
  return `${Math.round(x * 100)}%`;
}

function fmtMs(ms) {
  if (!ms) return "0ms";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Render a scorecard as a plain-text report. */
export function formatScorecard(sc) {
  const lines = [];

  lines.push("=== agnz eval scorecard ===");
  lines.push("");
  // Detail rows: one per (fixture × profile).
  lines.push(
    `${"FIXTURE".padEnd(18)}${"PROFILE".padEnd(16)}${"RESULT".padEnd(8)}${"STATUS".padEnd(10)}${"TURNS".padStart(6)}${"TOKENS".padStart(9)}  DETAIL`,
  );
  lines.push("-".repeat(90));
  for (const r of sc.results) {
    lines.push(
      `${r.fixture.slice(0, 17).padEnd(18)}${r.profile.slice(0, 15).padEnd(16)}${(r.pass ? "PASS" : "FAIL").padEnd(8)}${r.status.padEnd(10)}${String(r.metrics.turns).padStart(6)}${String(r.metrics.tokens).padStart(9)}  ${r.detail || ""}`,
    );
  }

  lines.push("");
  lines.push("per profile (ranked by pass rate, then token cost):");
  lines.push(
    `${"PROFILE".padEnd(16)}${"PASS".padStart(8)}${"TOKENS".padStart(10)}${"TOOL-ERR".padStart(10)}${"REPAIR".padStart(9)}${"TIME".padStart(9)}`,
  );
  lines.push("-".repeat(62));
  for (const p of sc.profiles) {
    lines.push(
      `${p.profile.slice(0, 15).padEnd(16)}${`${p.passed}/${p.total}`.padStart(8)}${String(p.tokens).padStart(10)}${pct(p.toolErrorRate).padStart(10)}${pct(p.repairRate).padStart(9)}${fmtMs(p.durationMs).padStart(9)}`,
    );
  }
  return lines.join("\n");
}
