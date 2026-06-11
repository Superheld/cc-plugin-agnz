// node:test coverage for evals/score.mjs (ADR 0011 §5).
//
// The runner needs a live model, but the scoring/aggregation is pure and is
// the part most likely to silently miscount — so it gets real coverage.
//
// Run with: node --test tests/evals-score.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildScorecard, formatScorecard } from "../evals/score.mjs";

function result(fixture, profile, pass, over = {}) {
  return {
    fixture,
    profile,
    pass,
    status: pass ? "final" : "max_turns",
    detail: "",
    metrics: { turns: 4, tokens: 100, toolCalls: 3, toolErrors: 0, repairs: 0, durationMs: 500, ...over },
  };
}

test("buildScorecard aggregates per profile and computes rates", () => {
  const sc = buildScorecard([
    result("create-file", "fast", true, { toolCalls: 4, toolErrors: 1, turns: 5, repairs: 1 }),
    result("edit-rename", "fast", false, { toolCalls: 6, toolErrors: 2, turns: 5, repairs: 0 }),
  ]);

  assert.equal(sc.profiles.length, 1);
  const p = sc.profiles[0];
  assert.equal(p.profile, "fast");
  assert.equal(p.passed, 1);
  assert.equal(p.total, 2);
  assert.equal(p.passRate, 0.5);
  assert.equal(p.toolCalls, 10);
  assert.equal(p.toolErrors, 3);
  assert.equal(p.toolErrorRate, 0.3); // 3 / 10
  assert.equal(p.turns, 10);
  assert.equal(p.repairs, 1);
  assert.equal(p.repairRate, 0.1); // 1 / 10 turns
});

test("buildScorecard ranks by pass rate then token cost", () => {
  const sc = buildScorecard([
    result("f1", "cheap-loser", false),
    result("f1", "winner", true, { tokens: 500 }),
    result("f1", "winner-pricey", true, { tokens: 900 }),
  ]);
  // Two profiles tie on pass rate (100%); the cheaper one ranks first.
  assert.deepEqual(
    sc.profiles.map((p) => p.profile),
    ["winner", "winner-pricey", "cheap-loser"],
  );
});

test("rates are zero (not NaN) when there is no activity", () => {
  const sc = buildScorecard([
    result("f", "idle", true, { turns: 0, toolCalls: 0, repairs: 0 }),
  ]);
  assert.equal(sc.profiles[0].toolErrorRate, 0);
  assert.equal(sc.profiles[0].repairRate, 0);
  assert.equal(sc.profiles[0].passRate, 1);
});

test("formatScorecard renders both the detail and per-profile tables", () => {
  const sc = buildScorecard([result("create-file", "fast", true)]);
  const out = formatScorecard(sc);
  assert.match(out, /agnz eval scorecard/);
  assert.match(out, /create-file/);
  assert.match(out, /per profile/);
  assert.match(out, /fast/);
});
