// The final reply is the ONLY thing the parent receives (no transcript access),
// so the thread summary derived from it must not throw the report away.
//
// Both fixtures are real dashboard finals: one opened with a markdown heading
// and stored "## Summary"; one opened with an announcement and stored
// "…Let me create a summary of what I've built:". Neither told the lead
// anything, which is exactly what drives it to go inspecting.
//
// Run with: node --test tests/final-report.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createThreadManager } from "../lib/threads.mjs";
import { createSandbox } from "../lib/sandbox.mjs";
import { createRegistry } from "../lib/tools/registry.mjs";
import { runThread } from "../lib/loop.mjs";
import { fakeChat, finalMessage } from "./_fake-llm.mjs";
import { SANDBOX_FRAMING } from "../lib/prompts.mjs";

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

async function finalSummary(text) {
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "dev", agentDef: { name: "dev", tools: [] } });
  const sandbox = createSandbox({ root: projectCwd, policy: {} });
  await runThread({
    thread, threadMgr, sandbox,
    registry: createRegistry(),
    profile: { baseUrl: "http://fake", model: "fake", name: "p" },
    chat: fakeChat([finalMessage(text)]),
    userMessage: "do it",
  });
  return (await threadMgr.getThread(thread.id)).summary;
}

test("a report opening with a heading summarises its first real line", async () => {
  const s = await finalSummary("## Summary\n\nRebuilt the transcript endpoint; all four test files pass.");
  assert.equal(s, "Rebuilt the transcript endpoint; all four test files pass.");
});

test("an announcement line is skipped in favour of the report itself", async () => {
  const s = await finalSummary(
    "Perfect! All tests pass. Let me create a summary of what I've built:\n\nAdded the mailbox view to the frontend.",
  );
  assert.equal(s, "Added the mailbox view to the frontend.");
});

test("a terse reply is still kept rather than dropped", async () => {
  assert.equal(await finalSummary("Task completed."), "Task completed.");
});

test("the prompt tells the agent its final reply is the whole report", () => {
  assert.match(SANDBOX_FRAMING, /final reply is the ONLY thing it receives/);
  assert.match(SANDBOX_FRAMING, /Changed/);
  assert.match(SANDBOX_FRAMING, /Verified/);
  assert.match(SANDBOX_FRAMING, /Open/);
  assert.match(SANDBOX_FRAMING, /"Task completed\." is not a report/);
  assert.doesNotMatch(SANDBOX_FRAMING, /\b(Skill|SendMessage|Grep)\s*[({]/, "no written-out call syntax may creep back in");
});
