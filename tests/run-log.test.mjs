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

// --- the loop actually writes it -------------------------------------------

test("a real run records its messages, its API calls and its boundaries", async () => {
  const { createThreadManager } = await import("../lib/threads.mjs");
  const { createSandbox } = await import("../lib/sandbox.mjs");
  const { createRegistry } = await import("../lib/tools/registry.mjs");
  const { runThread } = await import("../lib/loop.mjs");
  const { fakeChat, toolCall, finalMessage } = await import("./_fake-llm.mjs");
  const { writeFileSync } = await import("node:fs");

  const userDir = mkdtempSync(join(tmpdir(), "agnz-runlog-user-"));
  process.env.AGNZ_DATA_DIR = userDir;
  writeFileSync(resolve(cwd, "data.txt"), "payload");

  try {
    const threadMgr = createThreadManager();
    const thread = await threadMgr.createThread({
      cwd,
      name: "dev",
      agentDef: { name: "dev", tools: ["Read"] },
    });
    await runThread({
      thread,
      threadMgr,
      sandbox: createSandbox({ root: cwd, policy: { Read: "allow" } }),
      registry: createRegistry(),
      profile: { baseUrl: "http://192.168.0.9:11434/v1", model: "fake", name: "lanbox" },
      userMessage: "read the file",
      chat: fakeChat([toolCall("c1", "Read", { path: "data.txt" }), finalMessage("done")]),
    });

    const entries = await readThreadLog(cwd, thread.id);
    const types = entries.map((e) => e.type);
    assert.ok(types.includes("run_start"), "the run announces itself");
    assert.ok(types.includes("run_end"), "and closes itself");
    assert.ok(types.filter((t) => t === "api_request").length >= 2);
    assert.ok(types.filter((t) => t === "api_response").length >= 2);

    // Every entry belongs to exactly one run.
    const runs = new Set(entries.map((e) => e.run));
    assert.equal(runs.size, 1, "one run, one id on every entry");

    // The conversation is in there, and the requests do not duplicate it.
    const msgs = projectMessages(entries);
    assert.equal(msgs[0].role, "user");
    assert.equal(msgs[0].content, "read the file");
    assert.ok(msgs.some((m) => m.role === "tool"), "tool results are part of the history");
    assert.equal(msgs[msgs.length - 1].content, "done");

    const req = entries.find((e) => e.type === "api_request");
    assert.doesNotMatch(JSON.stringify(req), /read the file/, "requests name a range, not content");

    // The last request replays to exactly what the model was sent.
    const lastReq = entries.filter((e) => e.type === "api_request").pop();
    const replayed = reconstructRequest(entries, lastReq);
    assert.equal(replayed[0].content, "read the file");
    assert.ok(replayed.length >= 3, "user + assistant tool_calls + tool result");

    // The shadow transcript is still written, so a revert finds its data.
    const shadow = await threadMgr.readMessages(thread.id);
    assert.equal(shadow.length, msgs.length, "shadow and log hold the same conversation");
  } finally {
    delete process.env.AGNZ_DATA_DIR;
    rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
