// node:test coverage for the loop's mailbox drain (ADR 0002 / ADR 0011 §4).
//
// At the top of every turn the loop delivers new messages addressed to the
// agent as a synthetic user message and advances inboxCursor. It must skip
// messages the agent sent itself, and advance the cursor past unrelated
// traffic so a chatty workspace is not re-scanned every turn.
//
// Run with: node --test tests/mailbox.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createThreadManager } from "../lib/threads.mjs";
import { createSandbox } from "../lib/sandbox.mjs";
import { createRegistry } from "../lib/tools/registry.mjs";
import { runThread } from "../lib/loop.mjs";
import { appendMessage } from "../lib/messages-log.mjs";
import { fakeChat, finalMessage } from "./_fake-llm.mjs";

let projectCwd;
let userDir;

beforeEach(() => {
  projectCwd = mkdtempSync(join(tmpdir(), "agnz-mbox-cwd-"));
  userDir = mkdtempSync(join(tmpdir(), "agnz-mbox-user-"));
  process.env.AGNZ_DATA_DIR = userDir;
});

afterEach(() => {
  delete process.env.AGNZ_DATA_DIR;
  rmSync(projectCwd, { recursive: true, force: true });
  rmSync(userDir, { recursive: true, force: true });
});

function transcriptText(history) {
  return history.map((m) => `${m.role}: ${m.content || ""}`).join("\n");
}

test("delivers mail addressed to the agent and advances the cursor", async () => {
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({
    cwd: projectCwd,
    name: "dev",
    agentDef: { name: "dev" },
  });

  // Seed the durable log: one message for us, one for someone else, and one
  // we "sent" ourselves (must be skipped on delivery but still observed).
  await appendMessage(thread.cwd, { from: "parent", to: "dev", kind: "directive", text: "do the thing" });
  await appendMessage(thread.cwd, { from: "parent", to: "other", kind: "say", text: "not for you" });
  const last = await appendMessage(thread.cwd, { from: "dev", to: "*", kind: "status", text: "echo of myself" });

  const sandbox = createSandbox({ root: projectCwd, policy: {} });
  const registry = createRegistry();
  const profile = { baseUrl: "http://fake", model: "fake", name: "p" };

  const outcome = await runThread({
    thread, threadMgr, sandbox, registry, profile,
    chat: fakeChat([finalMessage("ok")]),
    userMessage: "start",
  });
  assert.equal(outcome.status, "final");

  const history = await threadMgr.readMessages(thread.id);
  const text = transcriptText(history);

  // The directive addressed to us is delivered...
  assert.match(text, /Inbox update/);
  assert.match(text, /do the thing/);
  // ...but neither the message for "other" nor our own echo is delivered.
  assert.doesNotMatch(text, /not for you/);
  assert.doesNotMatch(text, /echo of myself/);

  // Cursor advanced to the last *observed* id (not just the delivered one),
  // so unrelated traffic is not re-scanned next turn.
  const refreshed = await threadMgr.getThread(thread.id);
  assert.equal(refreshed.inboxCursor, last.id);
});

test("a turn with no new mail injects nothing", async () => {
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({
    cwd: projectCwd,
    name: "solo",
    agentDef: { name: "solo" },
  });
  const sandbox = createSandbox({ root: projectCwd, policy: {} });
  const registry = createRegistry();
  const profile = { baseUrl: "http://fake", model: "fake", name: "p" };

  const outcome = await runThread({
    thread, threadMgr, sandbox, registry, profile,
    chat: fakeChat([finalMessage("done")]),
    userMessage: "hello",
  });
  assert.equal(outcome.status, "final");

  const history = await threadMgr.readMessages(thread.id);
  assert.doesNotMatch(transcriptText(history), /Inbox update/);
});
