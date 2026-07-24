// node:test coverage for lib/trace-stats.mjs (ADR 0011 §2).
//
// aggregateTrace is pure, so most assertions need no IO. A couple of tests
// write a real trace.jsonl to a temp workspace to exercise the readers.
//
// Run with: node --test tests/trace-stats.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  aggregateTrace,
  aggregateThread,
  aggregateWorkspace,
  filesTouched,
  formatThread,
  formatWorkspace,
} from "../lib/trace-stats.mjs";

let cwd;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "agnz-stats-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** Sample trace for one finished thread: 2 turns, 1 tool call, 1 repair. */
function sampleTrace() {
  return [
    { ts: 1000, type: "thread_start", turn: 0, agent: "dev", model: "devstral", profile: "lm", maxTurns: 40 },
    { ts: 1010, type: "llm_call", turn: 0, latencyMs: 500, finishReason: "tool_calls", usage: { prompt: 100, completion: 20, total: 120 } },
    { ts: 1020, type: "repair", turn: 0, tool: "Edit", recovered: true },
    { ts: 1030, type: "tool_call", turn: 0, name: "Edit", latencyMs: 5, outcome: "ok" },
    { ts: 1500, type: "turn_start", turn: 1 },
    { ts: 1510, type: "llm_call", turn: 1, latencyMs: 300, finishReason: "stop", usage: { prompt: 130, completion: 10, total: 140 } },
    { ts: 1520, type: "thread_end", reason: "final", turns: 2, totals: {} },
  ];
}

test("aggregateTrace folds events into a correct summary", () => {
  const s = aggregateTrace(sampleTrace());

  assert.equal(s.agent, "dev");
  assert.equal(s.model, "devstral");
  assert.equal(s.profile, "lm");
  assert.equal(s.maxTurns, 40);

  // 1 thread_start + 1 turn_start = 2 turns, matching the 2 llm_calls.
  assert.equal(s.turns, 2);
  assert.equal(s.llmCalls, 2);
  assert.equal(s.llmLatencyMs, 800);
  assert.equal(s.avgLlmLatencyMs, 400);

  assert.deepEqual(s.tokens, { prompt: 230, completion: 30, total: 260 });

  assert.equal(s.toolCalls.total, 1);
  assert.equal(s.toolCalls.ok, 1);
  assert.equal(s.toolCalls.byName.Edit, 1);
  assert.equal(s.toolLatencyMs, 5);

  assert.equal(s.repairs.total, 1);
  assert.equal(s.repairs.recovered, 1);

  assert.equal(s.terminalReason, "final");
  assert.equal(s.durationMs, 520); // 1520 - 1000
});

test("aggregateTrace handles an empty/running thread without throwing", () => {
  const s = aggregateTrace([]);
  assert.equal(s.turns, 0);
  assert.equal(s.terminalReason, null);
  assert.equal(s.durationMs, 0);
  assert.equal(s.avgLlmLatencyMs, 0);
  // formatting an empty summary must not crash
  assert.match(formatThread("deadbeef-0000", s), /Trace stats/);
});

test("tool outcomes are counted by category", () => {
  const s = aggregateTrace([
    { ts: 1, type: "tool_call", name: "Bash", outcome: "ok" },
    { ts: 2, type: "tool_call", name: "Bash", outcome: "error" },
    { ts: 3, type: "tool_call", name: "Write", outcome: "denied" },
  ]);
  assert.equal(s.toolCalls.total, 3);
  assert.equal(s.toolCalls.ok, 1);
  assert.equal(s.toolCalls.error, 1);
  assert.equal(s.toolCalls.denied, 1);
  assert.equal(s.toolCalls.byName.Bash, 2);
});

test("filesTouched folds successful mutations into a per-path diff pointer", () => {
  const entries = [
    { type: "tool_call", name: "Read", target: "lib/a.mjs", outcome: "ok" },
    { type: "tool_call", name: "Write", target: "lib/a.mjs", outcome: "ok" },
    { type: "tool_call", name: "Edit", target: "lib/a.mjs", outcome: "ok" },
    { type: "tool_call", name: "Edit", target: "lib/a.mjs", outcome: "ok" },
    { type: "tool_call", name: "Edit", target: "lib/b.mjs", outcome: "ok" },
    // Failed/blocked mutations touched nothing.
    { type: "tool_call", name: "Write", target: "lib/c.mjs", outcome: "blocked" },
    { type: "tool_call", name: "Edit", target: "lib/d.mjs", outcome: "error" },
    // Target-less events pass through silently.
    { type: "tool_call", name: "Bash", outcome: "ok" },
    { type: "llm_call", latencyMs: 5 },
  ];
  assert.deepEqual(filesTouched(entries), ["lib/a.mjs (1 write, 2 edits)", "lib/b.mjs (1 edit)"]);
  assert.deepEqual(filesTouched([]), []);
  assert.deepEqual(filesTouched(null), []);
});

test("aggregateThread + aggregateWorkspace read real trace files", async () => {
  const threadsDir = join(cwd, ".claude", "agnz", "threads");
  mkdirSync(threadsDir, { recursive: true });
  const id = "11111111-2222-3333-4444-555555555555";
  const jsonl = sampleTrace().map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(threadsDir, `${id}.trace.jsonl`), jsonl);
  // a torn final line must not break parsing
  writeFileSync(
    join(threadsDir, `${id}.trace.jsonl`),
    jsonl + '{"ts":9999,"type":"llm_ca',
  );

  const single = await aggregateThread(cwd, id);
  assert.equal(single.llmCalls, 2);
  assert.equal(single.tokens.total, 260);

  const ws = await aggregateWorkspace(cwd);
  assert.equal(ws.totals.threads, 1);
  assert.equal(ws.totals.tokens.total, 260);
  assert.equal(ws.byModel.devstral.threads, 1);
  assert.equal(ws.byAgent.dev.tokens, 260);
  assert.match(formatWorkspace(ws), /Workspace trace stats/);
});
