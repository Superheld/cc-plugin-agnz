// node:test coverage for the repetition guard (lib/repetition.mjs).
//
// The fixtures are the real call sequences from the dashboard project's
// turn-limit deaths, so a regression is measured against what actually
// happened rather than a reconstruction.
//
// Run with: node --test tests/repetition.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mergeRange, coveredBy, fullRange, readRange, fmtRange,
  trackFocus, focusVerdict, NUDGE_AT, ASK_AT,
} from "../lib/repetition.mjs";

// --- range bookkeeping -----------------------------------------------------

test("merges overlapping and touching ranges", () => {
  assert.deepEqual(mergeRange([[10, 20]], 15, 30), [[10, 30]]);
  assert.deepEqual(mergeRange([[10, 20]], 21, 30), [[10, 30]], "touching ranges coalesce");
  assert.deepEqual(mergeRange([[10, 20]], 40, 50), [[10, 20], [40, 50]]);
  assert.deepEqual(mergeRange(undefined, 1, 5), [[1, 5]]);
});

test("coverage is strict containment, so widening still reads", () => {
  const ranges = [[184, 195]];
  assert.equal(coveredBy(ranges, 186, 189), true, "narrower slice is covered");
  assert.equal(coveredBy(ranges, 184, 195), true, "identical slice is covered");
  assert.equal(coveredBy(ranges, 169, 195), false, "widening is NOT covered");
  assert.equal(coveredBy(ranges, 190, 210), false, "partial overlap is NOT covered");
  assert.equal(coveredBy([], 1, 10), false);
});

test("a full read covers any later slice", () => {
  assert.equal(coveredBy(fullRange(), 500, 515), true);
});

test("an open-ended read runs to EOF", () => {
  assert.deepEqual(readRange({ start_line: 40 }), [40, Number.MAX_SAFE_INTEGER]);
  assert.equal(fmtRange(readRange({ start_line: 40 })), "40-end");
  assert.equal(fmtRange([10, 20]), "10-20");
});

test("dash-jsfix's read tail: the redundant windows are the ones caught", () => {
  // Verbatim tail of dash-jsfix — consecutive reads, no Edit between them.
  const seq = [[480, 510], [503, 510], [420, 450], [449, 470], [465, 485], [482, 510], [504, 510]];
  let ranges = [];
  const deduped = [];
  for (const [s, e] of seq) {
    if (coveredBy(ranges, s, e)) deduped.push(`${s}-${e}`);
    else ranges = mergeRange(ranges, s, e);
  }
  assert.deepEqual(deduped, ["503-510", "482-510", "504-510"]);
  assert.deepEqual(ranges, [[420, 510]], "the rest tiles into one contiguous range");
});

// --- focus tracking --------------------------------------------------------

test("a different path resets the streak", () => {
  let f = trackFocus(null, "/a.js");
  f = trackFocus(f, "/a.js");
  assert.equal(f.count, 2);
  f = trackFocus(f, "/b.js");
  assert.equal(f.count, 1, "moving between files is work, not circling");
});

test("edits do not reset the streak", () => {
  // The observed pathology interleaves Edits with re-reads; treating a
  // mutation as progress would blind the guard to exactly that case.
  let f = null;
  for (let i = 0; i < 5; i++) f = trackFocus(f, "/main.js");
  assert.equal(f.count, 5);
});

test("nudge fires once, then stays quiet until the ask threshold", () => {
  let f = null;
  for (let i = 0; i < NUDGE_AT; i++) f = trackFocus(f, "/main.js");
  assert.equal(focusVerdict(f), "nudge");

  f = { ...f, nudged: true };
  assert.equal(focusVerdict(f), "quiet", "a nudged streak must not deadlock the agent");

  f = trackFocus(f, "/main.js");
  assert.equal(f.nudged, true, "the nudged flag survives the same streak");
  assert.equal(focusVerdict(f), "quiet");
});

test("escalates to an ask once the streak reaches ASK_AT", () => {
  let f = null;
  for (let i = 0; i < ASK_AT; i++) f = trackFocus(f, "/main.js");
  assert.equal(f.count, ASK_AT);
  assert.equal(focusVerdict(f), "ask");
});

test("dash-jsfix3 would have been stopped long before the turn limit", () => {
  // 24 consecutive calls against one file; the run actually died at 40 turns.
  let f = null;
  const events = [];
  for (let i = 1; i <= 24; i++) {
    f = trackFocus(f, "/frontend/js/main.js");
    const v = focusVerdict(f);
    if (v !== "quiet") events.push([i, v]);
    if (v === "nudge") f = { ...f, nudged: true };
    if (v === "ask") f = { path: f.path, count: 0, nudged: false };
  }
  // The ladder re-arms after an ask: if the agent is still circling the same
  // file 8 calls after the lead answered, it earns the corrective again.
  assert.deepEqual(events, [[NUDGE_AT, "nudge"], [ASK_AT, "ask"], [ASK_AT + NUDGE_AT, "nudge"]]);
  assert.ok(events[1][0] < 40, "intervention lands well before the turn limit that killed this run");
});

test("focusVerdict tolerates a missing focus record", () => {
  assert.equal(focusVerdict(null), "quiet");
  assert.equal(focusVerdict(undefined), "quiet");
});

// --- loop integration ------------------------------------------------------

import { test as itest, beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createThreadManager } from "../lib/threads.mjs";
import { createSandbox } from "../lib/sandbox.mjs";
import { createRegistry } from "../lib/tools/registry.mjs";
import { runThread } from "../lib/loop.mjs";
import { fakeChat, toolCall, finalMessage } from "./_fake-llm.mjs";

let projectCwd, userDir;

beforeEach(() => {
  projectCwd = mkdtempSync(join(tmpdir(), "agnz-rep-cwd-"));
  userDir = mkdtempSync(join(tmpdir(), "agnz-rep-user-"));
  process.env.AGNZ_DATA_DIR = userDir;
});
afterEach(() => {
  delete process.env.AGNZ_DATA_DIR;
  rmSync(projectCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function bigFile() {
  writeFileSync(join(projectCwd, "main.js"), Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join("\n"));
}

function setup() {
  return {
    sandbox: createSandbox({ root: projectCwd, policy: { Read: "allow", Grep: "allow" } }),
    registry: createRegistry(),
    profile: { baseUrl: "http://fake", model: "fake", name: "p" },
  };
}

itest("a covered re-read is answered with a pointer, not the bytes", async () => {
  bigFile();
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "dev", agentDef: { name: "dev", tools: ["Read"] } });
  const { sandbox, registry, profile } = setup();

  const chat = fakeChat([
    toolCall("r1", "Read", { path: "main.js", start_line: 184, end_line: 195 }),
    toolCall("r2", "Read", { path: "main.js", start_line: 186, end_line: 189 }),
    finalMessage("done"),
  ]);
  await runThread({ thread, threadMgr, sandbox, registry, profile, chat, userMessage: "look" });

  const history = await threadMgr.readMessages(thread.id);
  const first = history.find((m) => m.role === "tool" && m.tool_call_id === "r1");
  const second = history.find((m) => m.role === "tool" && m.tool_call_id === "r2");
  assert.match(first.content, /line 190/, "the first read really returned content");
  assert.match(second.content, /already in your context/i);
  assert.ok(!/line 187/.test(second.content), "the redundant slice must not re-send bytes");
});

itest("widening the window still returns content", async () => {
  bigFile();
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "dev", agentDef: { name: "dev", tools: ["Read"] } });
  const { sandbox, registry, profile } = setup();

  const chat = fakeChat([
    toolCall("r1", "Read", { path: "main.js", start_line: 184, end_line: 195 }),
    toolCall("r2", "Read", { path: "main.js", start_line: 169, end_line: 195 }),
    finalMessage("done"),
  ]);
  await runThread({ thread, threadMgr, sandbox, registry, profile, chat, userMessage: "look" });

  const history = await threadMgr.readMessages(thread.id);
  const second = history.find((m) => m.role === "tool" && m.tool_call_id === "r2");
  assert.match(second.content, /line 170/, "widening must not be deduped away");
});

itest("circling one file earns a corrective, then pauses to ask the lead", async () => {
  bigFile();
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "dev", agentDef: { name: "dev", tools: ["Read"] } });
  const { sandbox, registry, profile } = setup();

  // 20 distinct, non-overlapping slices: stage 1 can never fire, so this
  // isolates the focus counter.
  const script = [];
  for (let i = 0; i < 20; i++) {
    script.push(toolCall(`r${i}`, "Read", { path: "main.js", start_line: 1 + i * 20, end_line: 10 + i * 20 }));
  }
  script.push(finalMessage("done"));
  const result = await runThread({ thread, threadMgr, sandbox, registry, profile, chat: fakeChat(script), userMessage: "find the bug" });

  const history = await threadMgr.readMessages(thread.id);
  const nudge = history.find((m) => m.role === "tool" && /circling rather than converging/i.test(m.content || ""));
  assert.ok(nudge, "the agent must be told it is circling");
  assert.equal(history.find((m) => m.role === "tool" && m.tool_call_id === `r${NUDGE_AT - 1}`).content, nudge.content,
    "the corrective replaces exactly the NUDGE_AT-th call");

  assert.equal(result.status, "awaiting_input", "it must end paused, not run to the turn limit");
  const meta = await threadMgr.getThread(thread.id);
  assert.equal(meta.pending.kind, "question");
  assert.match(meta.pending.question, /consecutive tool calls against 'main\.js'/);
  assert.match(meta.summary, /stuck on main\.js/);
});

itest("moving between files never trips the guard", async () => {
  bigFile();
  writeFileSync(join(projectCwd, "other.js"), "x = 1\n");
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "dev", agentDef: { name: "dev", tools: ["Read"] } });
  const { sandbox, registry, profile } = setup();

  const script = [];
  for (let i = 0; i < 20; i++) {
    const path = i % 2 === 0 ? "main.js" : "other.js";
    script.push(toolCall(`r${i}`, "Read", { path, start_line: 1 + i, end_line: 5 + i }));
  }
  script.push(finalMessage("done"));
  const result = await runThread({ thread, threadMgr, sandbox, registry, profile, chat: fakeChat(script), userMessage: "compare" });

  assert.equal(result.status, "final", "alternating files is legitimate work");
  const history = await threadMgr.readMessages(thread.id);
  assert.ok(!history.some((m) => /circling rather than converging/i.test(m.content || "")));
});
