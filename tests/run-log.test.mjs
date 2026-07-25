// node:test coverage for the unified per-thread log (ADR 0020).
//
// The properties that matter are the two rules that keep the file from
// re-creating the redundancy it exists to remove: an api_request stores no
// message content (it names a range), and replaying that range reproduces the
// request exactly. Plus the projections every other view is built from.
//
// Run with: node --test tests/run-log.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  openThreadLog,
  readThreadLog,
  threadLogFile,
  projectMessages,
  projectApiCalls,
  reconstructRequest,
  appendWorkspaceLog,
  readWorkspaceLog,
} from "../lib/run-log.mjs";

let cwd;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "agnz-runlog-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test("entries carry a monotonic seq and the run they belong to", async () => {
  const log = await openThreadLog({ cwd, threadId: "t1", runId: "run-a" });
  log.setTurn(0);
  await log.append("message", { role: "user", content: "hi" });
  await log.append("message", { role: "assistant", content: "ok" });

  const entries = await readThreadLog(cwd, "t1");
  assert.deepEqual(entries.map((e) => e.seq), [1, 2]);
  assert.ok(entries.every((e) => e.run === "run-a" && e.turn === 0));
});

test("a second run continues the sequence instead of restarting it", async () => {
  const first = await openThreadLog({ cwd, threadId: "t1", runId: "run-a" });
  await first.append("message", { role: "user", content: "one" });
  await first.append("message", { role: "assistant", content: "two" });

  const second = await openThreadLog({ cwd, threadId: "t1", runId: "run-b" });
  await second.append("message", { role: "user", content: "three" });

  const entries = await readThreadLog(cwd, "t1");
  assert.deepEqual(entries.map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(entries.map((e) => e.run), ["run-a", "run-a", "run-b"]);
});

test("the message projection returns wire shape with the envelope stripped", async () => {
  const log = await openThreadLog({ cwd, threadId: "t1", runId: "r" });
  await log.append("message", { role: "user", content: "hi" });
  await log.append("api_request", { model: "m", messages: { fromSeq: 1, toSeq: 1 } });
  await log.append("message", {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "c1", type: "function", function: { name: "Read", arguments: "{}" } }],
  });

  const msgs = projectMessages(await readThreadLog(cwd, "t1"));
  assert.equal(msgs.length, 2, "non-message events are not part of the history");
  assert.deepEqual(Object.keys(msgs[0]).sort(), ["content", "role"]);
  assert.equal(msgs[1].tool_calls[0].function.name, "Read");
});

test("an api_request stores no message content and still replays exactly", async () => {
  const log = await openThreadLog({ cwd, threadId: "t1", runId: "r" });
  await log.append("message", { role: "user", content: "first task" });
  await log.append("message", { role: "assistant", content: "done" });
  await log.append("message", { role: "user", content: "second task" });

  // Name the range instead of copying it — ADR 0020 §3.
  const from = 1;
  const to = log.lastSeq();
  const req = await log.append("api_request", {
    model: "devstral-2:64k",
    prefix: "a3f1c9d2",
    messages: { fromSeq: from, toSeq: to },
  });

  const serialised = JSON.stringify(req);
  assert.doesNotMatch(serialised, /first task/, "the request does not copy the conversation");
  assert.doesNotMatch(serialised, /second task/);

  const entries = await readThreadLog(cwd, "t1");
  const replayed = reconstructRequest(entries, req);
  assert.deepEqual(replayed, [
    { role: "user", content: "first task" },
    { role: "assistant", content: "done" },
    { role: "user", content: "second task" },
  ]);
});

test("a compacted range replays from the marker, not from the start", async () => {
  const log = await openThreadLog({ cwd, threadId: "t1", runId: "r" });
  await log.append("message", { role: "user", content: "ancient" });
  await log.append("message", { role: "assistant", content: "older" });
  const marker = await log.append("message", { role: "user", content: "SUMMARY", _compact: true });
  await log.append("message", { role: "assistant", content: "fresh" });

  const req = await log.append("api_request", {
    model: "m",
    messages: { fromSeq: marker.seq, toSeq: log.lastSeq() },
  });
  const replayed = reconstructRequest(await readThreadLog(cwd, "t1"), req);
  assert.equal(replayed.length, 2);
  assert.equal(replayed[0].content, "SUMMARY");
  assert.equal(replayed[0]._compact, true, "the marker flag survives the projection");
});

test("the API projection pairs each call with its answer", async () => {
  const log = await openThreadLog({ cwd, threadId: "t1", runId: "r" });
  await log.append("api_request", { model: "m", messages: { fromSeq: 0, toSeq: 0 } });
  await log.append("api_response", { latencyMs: 1200, finishReason: "stop" });
  await log.append("api_request", { model: "m", messages: { fromSeq: 0, toSeq: 0 } });
  await log.append("api_error", {
    latencyMs: 4,
    endpoint: "http://192.168.0.9:11434/v1",
    detail: { kind: "network", code: "EHOSTUNREACH" },
  });

  const calls = projectApiCalls(await readThreadLog(cwd, "t1"));
  assert.deepEqual(calls.map((c) => c.outcome), ["ok", "error"]);
  assert.equal(calls[1].response.detail.code, "EHOSTUNREACH");
});

test("a request killed mid-call shows as unanswered rather than vanishing", async () => {
  const log = await openThreadLog({ cwd, threadId: "t1", runId: "r" });
  await log.append("api_request", { model: "m", messages: { fromSeq: 0, toSeq: 0 } });

  const calls = projectApiCalls(await readThreadLog(cwd, "t1"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].outcome, "unanswered");
});

test("a torn final line does not make the rest of the log unreadable", async () => {
  const log = await openThreadLog({ cwd, threadId: "t1", runId: "r" });
  await log.append("message", { role: "user", content: "intact" });
  // Simulate a process killed mid-append.
  appendFileSync(threadLogFile(cwd, "t1"), '{"seq":2,"type":"mess', "utf8");

  const entries = await readThreadLog(cwd, "t1");
  assert.equal(entries.length, 1);
  assert.equal(projectMessages(entries)[0].content, "intact");
});

test("a thread with no log reads as empty rather than throwing", async () => {
  assert.deepEqual(await readThreadLog(cwd, "never-existed"), []);
});

test("workspace-scoped events have a home of their own", async () => {
  // The incident behind the ADR: `config test` against an unreachable host.
  await appendWorkspaceLog(cwd, {
    type: "server_contact",
    verb: "config test",
    endpoint: "http://192.168.178.66:11434/v1",
    outcome: "error",
    detail: { kind: "network", code: "EHOSTUNREACH" },
  });

  const entries = await readWorkspaceLog(cwd);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].detail.code, "EHOSTUNREACH");
  assert.equal(entries[0].run, null, "workspace events belong to no run");
});
