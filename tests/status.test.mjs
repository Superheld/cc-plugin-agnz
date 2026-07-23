// node:test coverage for the judgment layer (ADR 0019): status is fact,
// verdict is diagnosis. Pure functions — no I/O, no workspace needed.
//
// Run with: node --test tests/status.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveInFlight,
  judgeThread,
  fmtDur,
  HUNG_FLOOR_MS,
} from "../lib/status.mjs";

const NOW = 1_000_000_000_000;
const MIN = 60 * 1000;

// Trace helpers: a completed turn is turn_start followed by llm_call.
const turn = (ts, latencyMs) => [
  { type: "turn_start", ts },
  { type: "llm_call", ts: ts + latencyMs, latencyMs },
];

test("deriveInFlight: trailing turn_start is an in-flight LLM call; median from completed calls", () => {
  const entries = [
    ...turn(NOW - 30 * MIN, 2 * MIN),
    ...turn(NOW - 25 * MIN, 3 * MIN),
    ...turn(NOW - 20 * MIN, 2 * MIN),
    { type: "turn_start", ts: NOW - 15 * MIN }, // never returned
  ];
  const { llmInFlightMs, medianLlmMs } = deriveInFlight(entries, NOW);
  assert.equal(llmInFlightMs, 15 * MIN);
  assert.equal(medianLlmMs, 2 * MIN);
});

test("deriveInFlight: a completed last call means nothing is in flight", () => {
  const { llmInFlightMs } = deriveInFlight([...turn(NOW - 5 * MIN, MIN)], NOW);
  assert.equal(llmInFlightMs, null);
});

test("judge: running with in-flight call at 10x median is hung, with evidence and interrupt action", () => {
  // The field incident: ~2.4m median, call in flight for 43m (18x).
  const entries = [
    ...turn(NOW - 60 * MIN, 2.4 * MIN),
    ...turn(NOW - 55 * MIN, 2.4 * MIN),
    ...turn(NOW - 50 * MIN, 2.4 * MIN),
    { type: "turn_start", ts: NOW - 43 * MIN },
  ];
  const j = judgeThread({ thread: { id: "abc12345", name: "dash-transcript", status: "running" }, entries, now: NOW });
  assert.equal(j.verdict, "hung");
  assert.match(j.evidence, /LLM call running 43m \(median 2m\)/);
  assert.equal(j.action, "agnz interrupt dash-transcript");
});

test("judge: hung floor protects cold threads — below 10 min is never hung without history", () => {
  const entries = [{ type: "thread_start", ts: NOW - 9 * MIN }];
  const j = judgeThread({ thread: { id: "a", name: "cold", status: "running" }, entries, now: NOW });
  assert.equal(j.verdict, "working");
  const j2 = judgeThread(
    { thread: { id: "a", name: "cold", status: "running" }, entries: [{ type: "thread_start", ts: NOW - 11 * MIN }], now: NOW },
  );
  assert.equal(j2.verdict, "hung");
  assert.match(j2.evidence, /no median yet/);
});

test("judge: a slow-but-not-hung call gets verdict slow with no paging action", () => {
  const entries = [
    ...turn(NOW - 30 * MIN, MIN),
    ...turn(NOW - 28 * MIN, MIN),
    { type: "turn_start", ts: NOW - 4 * MIN }, // 4x median, below the 10m floor
  ];
  const j = judgeThread({ thread: { id: "a", name: "s", status: "running" }, entries, now: NOW });
  assert.equal(j.verdict, "slow");
  assert.equal(j.action, null);
});

test("judge: awaiting question and approval carry their resolving verbs", () => {
  const q = judgeThread({
    thread: { id: "a", name: "dev", status: "awaiting_input", pending: { kind: "question", question: "Use US spelling?" } },
    now: NOW,
  });
  assert.equal(q.verdict, "awaiting-answer");
  assert.match(q.evidence, /US spelling/);
  assert.match(q.action, /agnz answer dev/);

  const a = judgeThread({
    thread: { id: "a", name: "dev", status: "awaiting_input", pending: { kind: "approval", name: "Bash" } },
    now: NOW,
  });
  assert.equal(a.verdict, "awaiting-approval");
  assert.equal(a.evidence, "tool: Bash");
  assert.match(a.action, /agnz approve dev/);
});

test("judge: error carries the message; fresh idle is quiet; old idle is stale", () => {
  const e = judgeThread({ thread: { id: "abcd1234", status: "error", error: { message: "connection refused" } }, now: NOW });
  assert.equal(e.verdict, "error");
  assert.equal(e.evidence, "connection refused");
  assert.match(e.action, /agnz remove abcd1234/);

  const fresh = judgeThread({ thread: { id: "a", name: "x", status: "idle", updatedAt: NOW - 60 * MIN }, now: NOW });
  assert.deepEqual(fresh, { verdict: "done", evidence: null, action: null });

  const old = judgeThread({ thread: { id: "a", name: "x", status: "idle", updatedAt: NOW - 25 * 60 * MIN }, now: NOW });
  assert.equal(old.verdict, "stale");
});

test("fmtDur renders the glossary duration grammar", () => {
  assert.equal(fmtDur(40 * 1000), "40s");
  assert.equal(fmtDur(22 * MIN), "22m");
  assert.equal(fmtDur(3 * 60 * MIN), "3h");
  assert.equal(fmtDur(50 * 60 * MIN * 24), "50d");
  assert.equal(fmtDur(HUNG_FLOOR_MS), "10m");
});
