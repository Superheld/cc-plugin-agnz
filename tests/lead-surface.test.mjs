// The lead's surface is deliberately small: start, answer, stop, remove — and
// an overview of who is running. Nothing analytical.
//
// Every assertion here pins an ABSENCE. The removed fields (turns, tokens,
// ctx, last tool call, trace stats, filesTouched, recent turns, the mailbox
// verb) each looked individually reasonable, which is how they accumulated
// into a dashboard the lead read on every prompt. These tests exist so the
// next well-meaning addition has to argue with a red test first.
//
// Run with: node --test tests/lead-surface.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildShowView } from "../bin/agnz.mjs";
import { formatThreadsDetailed } from "../scripts/hooks/_lib.mjs";

const THREAD = {
  id: "1234abcd-0000-0000-0000-000000000000",
  name: "dev",
  agentDef: { name: "dev", description: "does things", tools: ["Read", "Edit"] },
  status: "awaiting_input",
  summary: "done — fixed the serializer; transcript endpoint returns 200.",
  description: "serializer fix",
  cwd: "/tmp/project",
  pending: { toolCallId: "c1", kind: "question", question: "Which branch?" },
  card: { turns: 33, tokens: 91000, ctxTokens: 12000, task: "fix serializer" },
  error: null,
};

test("show carries what the action verbs need, and nothing more", () => {
  const view = buildShowView(THREAD);
  assert.deepEqual(Object.keys(view), ["thread"], "no sibling blocks (stats, filesTouched, recent)");
  assert.equal(view.thread.status, "awaiting_input");
  assert.equal(view.thread.pending.question, "Which branch?", "answer needs the question");
  assert.match(view.thread.summary, /fixed the serializer/, "the agent's own report line survives");
  assert.equal(view.thread.role, "dev");
});

test("show exposes no telemetry, no transcript, no card", () => {
  const view = buildShowView(THREAD);
  for (const gone of ["stats", "recent", "filesTouched"]) {
    assert.equal(view[gone], undefined, `${gone} must not be a lead-facing field`);
  }
  assert.equal(view.thread.card, undefined, "the resume card is turns+tokens by another name");
  assert.equal(view.thread.verdict, undefined, "a verdict is a judgment the lead had to interpret");
  assert.equal(view.thread.activity, undefined, "liveness exposes the last tool call");
  const json = JSON.stringify(view);
  assert.doesNotMatch(json, /\b(tokens|ctxTokens|turns|toolCalls|repairs|latency)\b/i);
});

test("show still reports a pendingRun so an idle thread is not misread as finished", () => {
  const view = buildShowView({ ...THREAD, status: "idle", pendingRun: { spawnedAt: 1 } });
  assert.deepEqual(view.thread.pendingRun, { spawnedAt: 1 });
});

test("the hook block names threads and their state, without vital signs", () => {
  const block = formatThreadsDetailed(
    [{
      id: "1234abcd-0000-0000-0000-000000000000",
      name: "dev",
      status: "running",
      updatedAt: Date.now(),
      summary: "working: fix the serializer",
      spend: { turns: 33, tokens: 91000, lastCtx: 12000 },
      ctxTokens: 12000,
      lastActivity: { name: "Write", target: "web/server.py", ts: Date.now() - 12000 },
    }],
    Date.now(),
  );
  assert.match(block, /dev:1234abcd/, "the addressable handle stays");
  assert.match(block, /running/);
  assert.match(block, /fix the serializer/, "the summary is the point of the block");

  assert.doesNotMatch(block, /turns/, "turn count is telemetry");
  assert.doesNotMatch(block, /ctx/, "context size is telemetry");
  assert.doesNotMatch(block, /last:/, "the last tool call is telemetry");
  assert.doesNotMatch(block, /generating/, "an in-flight phase label is telemetry");
  assert.doesNotMatch(block, /Write web\/server\.py/);
});

test("a hung thread still reaches the lead — exceptions push, metrics do not", () => {
  const now = Date.now();
  const block = formatThreadsDetailed(
    [{
      id: "dead0001-0000-0000-0000-000000000000",
      name: "stuck",
      status: "running",
      updatedAt: now - 30 * 60_000,
      summary: "working: something",
      runState: { llmInFlightMs: 30 * 60_000, medianMs: 5_000 },
    }],
    now,
  );
  assert.match(block, /stuck:dead0001/);
  assert.match(block, /hung|hängt|stalled/i, "the one exception that must still surface");
});

test("the mailbox verb is gone from the CLI", () => {
  const src = readFileSync(new URL("../bin/agnz.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /case "mailbox"/, "a searchable message log is an observer surface");
  assert.doesNotMatch(src, /readAllMessages/, "and its reader should be gone with it");
});
