// node:test coverage for the loop's pause/resume machinery (ADR 0011 §4).
//
// The riskiest, previously-untested paths: approval pause -> allow/deny,
// question pause -> answer, a multi-tool-call turn where the first call
// pauses and the leftover must be drained on resume, and error propagation.
//
// Run with: node --test tests/loop-resume.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createThreadManager } from "../lib/threads.mjs";
import { createSandbox } from "../lib/sandbox.mjs";
import { createRegistry } from "../lib/tools/registry.mjs";
import { runThread } from "../lib/loop.mjs";
import { fakeChat, toolCall, toolCalls, finalMessage } from "./_fake-llm.mjs";

let projectCwd;
let userDir;

beforeEach(() => {
  projectCwd = mkdtempSync(join(tmpdir(), "agnz-resume-cwd-"));
  userDir = mkdtempSync(join(tmpdir(), "agnz-resume-user-"));
  process.env.AGNZ_DATA_DIR = userDir;
});

afterEach(() => {
  delete process.env.AGNZ_DATA_DIR;
  rmSync(projectCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function makeThread(threadMgr, policy, chat) {
  const sandbox = createSandbox({ root: projectCwd, policy });
  const registry = createRegistry();
  const profile = { baseUrl: "http://fake", model: "fake", name: "p" };
  return { sandbox, registry, profile, chat };
}

test("approval pause -> allow runs the tool and finishes", async () => {
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "dev", agentDef: { name: "dev" } });
  const chat = fakeChat([
    toolCall("c1", "Write", { path: "out.txt", content: "hello" }),
    finalMessage("wrote it"),
  ]);
  const { sandbox, registry, profile } = makeThread(threadMgr, {}, chat); // Write -> ask

  const paused = await runThread({ thread, threadMgr, sandbox, registry, profile, chat, userMessage: "write a file" });
  assert.equal(paused.status, "awaiting_input");
  assert.equal(paused.pending.kind, "approval");
  assert.equal(paused.pending.name, "Write");
  assert.equal(existsSync(join(projectCwd, "out.txt")), false, "tool must not run before approval");

  const resumed = await threadMgr.getThread(thread.id);
  const done = await runThread({
    thread: resumed, threadMgr, sandbox, registry, profile, chat,
    resumeInput: { toolCallId: resumed.pending.toolCallId, decision: "allow" },
  });
  assert.equal(done.status, "final");
  assert.equal(readFileSync(join(projectCwd, "out.txt"), "utf8"), "hello");
});

test("approval pause -> deny skips the tool and injects a denial", async () => {
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "dev", agentDef: { name: "dev" } });
  const chat = fakeChat([
    toolCall("c1", "Write", { path: "nope.txt", content: "x" }),
    finalMessage("understood"),
  ]);
  const { sandbox, registry, profile } = makeThread(threadMgr, {}, chat);

  const paused = await runThread({ thread, threadMgr, sandbox, registry, profile, chat, userMessage: "write" });
  assert.equal(paused.pending.kind, "approval");

  const resumed = await threadMgr.getThread(thread.id);
  const done = await runThread({
    thread: resumed, threadMgr, sandbox, registry, profile, chat,
    resumeInput: { toolCallId: resumed.pending.toolCallId, decision: "deny" },
  });
  assert.equal(done.status, "final");
  assert.equal(existsSync(join(projectCwd, "nope.txt")), false);

  const history = await threadMgr.readMessages(thread.id);
  const toolResult = history.find((m) => m.role === "tool");
  assert.match(toolResult.content, /denied/i);
});

test("question pause -> answer injects the answer as the tool result", async () => {
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "dev", agentDef: { name: "dev" } });
  const chat = fakeChat([
    toolCall("q1", "AskUser", { question: "proceed?" }),
    finalMessage("great"),
  ]);
  const { sandbox, registry, profile } = makeThread(threadMgr, {}, chat);

  const paused = await runThread({ thread, threadMgr, sandbox, registry, profile, chat, userMessage: "ask me" });
  assert.equal(paused.status, "awaiting_input");
  assert.equal(paused.pending.kind, "question");

  const resumed = await threadMgr.getThread(thread.id);
  const done = await runThread({
    thread: resumed, threadMgr, sandbox, registry, profile, chat,
    resumeInput: { toolCallId: resumed.pending.toolCallId, answer: "yes, go ahead" },
  });
  assert.equal(done.status, "final");

  const history = await threadMgr.readMessages(thread.id);
  const toolResult = history.find((m) => m.role === "tool" && m.tool_call_id === "q1");
  assert.equal(toolResult.content, "yes, go ahead");
});

test("a paused first tool call leaves the second to be drained on resume", async () => {
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "dev", agentDef: { name: "dev" } });
  // Turn 0 calls Write (ask) then LS (allow) in one assistant message.
  const chat = fakeChat([
    toolCalls([
      { id: "w1", name: "Write", args: { path: "a.txt", content: "A" } },
      { id: "l1", name: "LS", args: { path: "." } },
    ]),
    finalMessage("both done"),
  ]);
  const { sandbox, registry, profile } = makeThread(threadMgr, { LS: "allow" }, chat);

  const paused = await runThread({ thread, threadMgr, sandbox, registry, profile, chat, userMessage: "do both" });
  assert.equal(paused.pending.name, "Write", "Write pauses first");

  // The second call (LS) must not have run yet.
  let history = await threadMgr.readMessages(thread.id);
  assert.equal(history.some((m) => m.role === "tool" && m.tool_call_id === "l1"), false);

  const resumed = await threadMgr.getThread(thread.id);
  const done = await runThread({
    thread: resumed, threadMgr, sandbox, registry, profile, chat,
    resumeInput: { toolCallId: resumed.pending.toolCallId, decision: "allow" },
  });
  assert.equal(done.status, "final");

  // Write ran (file exists) and the leftover LS was drained (result present).
  assert.equal(readFileSync(join(projectCwd, "a.txt"), "utf8"), "A");
  history = await threadMgr.readMessages(thread.id);
  const lsResult = history.find((m) => m.role === "tool" && m.tool_call_id === "l1");
  assert.ok(lsResult, "leftover LS must be drained on resume");
  assert.match(lsResult.content, /a\.txt/);
});

test("an LLM error marks the thread error and rethrows", async () => {
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "dev", agentDef: { name: "dev" } });
  const chat = fakeChat([{ error: "boom from llm" }]);
  const { sandbox, registry, profile } = makeThread(threadMgr, {}, chat);

  await assert.rejects(
    runThread({ thread, threadMgr, sandbox, registry, profile, chat, userMessage: "go" }),
    /boom from llm/,
  );

  const after = await threadMgr.getThread(thread.id);
  assert.equal(after.status, "error");
  assert.match(after.error.message, /boom from llm/);
});

test("a run stamps a live 'working:' summary that replaces the previous segment's outcome", async () => {
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "dev", agentDef: { name: "dev" } });
  // A previous segment left its outcome on the meta — exactly the state that
  // read as CURRENT status in list/hook while the thread was running again.
  await threadMgr.setStatus(thread.id, "idle", { summary: "reached turn limit (40)" });

  // Capture the summary mid-run: at the first chat() call the run-start stamp
  // has happened, the finish stamp has not.
  let midRunSummary = null;
  const inner = fakeChat([finalMessage("all done")]);
  const chat = async (...args) => {
    midRunSummary = (await threadMgr.getThread(thread.id)).summary;
    return inner(...args);
  };
  const { sandbox, registry, profile } = makeThread(threadMgr, {}, chat);
  await runThread({
    thread: await threadMgr.getThread(thread.id),
    threadMgr, sandbox, registry, profile, chat,
    userMessage: "Refactor the parser module",
  });

  assert.equal(midRunSummary, "working: Refactor the parser module");
  const after = await threadMgr.getThread(thread.id);
  assert.notEqual(after.summary, midRunSummary, "the finish stamp overwrites the working marker");
});
