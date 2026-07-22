// node:test coverage for ADR 0013 — tool workflow discipline.
//
// The harness keeps the model on the rails via a dispatch-path interceptor
// backed by a per-thread known-files state:
//   - Read before Write/Edit: block a mutation of an existing, unread file.
//   - Grep before Read: redirect a full read of a large file.
// New files and slices pass; reading marks a file known so the later Write runs.
//
// Run with: node --test tests/workflow-discipline.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createThreadManager } from "../lib/threads.mjs";
import { createSandbox } from "../lib/sandbox.mjs";
import { createRegistry } from "../lib/tools/registry.mjs";
import { runThread } from "../lib/loop.mjs";
import { fakeChat, toolCall, finalMessage } from "./_fake-llm.mjs";

let projectCwd;
let userDir;

beforeEach(() => {
  projectCwd = mkdtempSync(join(tmpdir(), "agnz-wf-cwd-"));
  userDir = mkdtempSync(join(tmpdir(), "agnz-wf-user-"));
  process.env.AGNZ_DATA_DIR = userDir;
});

afterEach(() => {
  delete process.env.AGNZ_DATA_DIR;
  rmSync(projectCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function setup(policy) {
  const sandbox = createSandbox({ root: projectCwd, policy });
  const registry = createRegistry();
  const profile = { baseUrl: "http://fake", model: "fake", name: "p" };
  return { sandbox, registry, profile };
}

function lastToolResult(history, callId) {
  return history.find((m) => m.role === "tool" && m.tool_call_id === callId);
}

test("Write to an existing unread file is blocked with a corrective prompt", async () => {
  writeFileSync(join(projectCwd, "existing.txt"), "original content");
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "dev", agentDef: { name: "dev", tools: ["Read", "Write"] } });
  const { sandbox, registry, profile } = setup({ Read: "allow", Write: "allow" });

  const chat = fakeChat([
    toolCall("w1", "Write", { path: "existing.txt", content: "CLOBBERED" }),
    finalMessage("ok"),
  ]);
  await runThread({ thread, threadMgr, sandbox, registry, profile, chat, userMessage: "overwrite it" });

  // File must be untouched, and the agent got a "read it first" correction.
  assert.equal(readFileSync(join(projectCwd, "existing.txt"), "utf8"), "original content");
  const history = await threadMgr.readMessages(thread.id);
  const res = lastToolResult(history, "w1");
  assert.match(res.content, /Workflow:.*read 'existing\.txt'/i);
});

test("Read then Write the same file is allowed", async () => {
  writeFileSync(join(projectCwd, "existing.txt"), "original");
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "dev", agentDef: { name: "dev", tools: ["Read", "Write"] } });
  const { sandbox, registry, profile } = setup({ Read: "allow", Write: "allow" });

  const chat = fakeChat([
    toolCall("r1", "Read", { path: "existing.txt" }),
    toolCall("w1", "Write", { path: "existing.txt", content: "UPDATED", overwrite: true }),
    finalMessage("done"),
  ]);
  await runThread({ thread, threadMgr, sandbox, registry, profile, chat, userMessage: "update it" });

  assert.equal(readFileSync(join(projectCwd, "existing.txt"), "utf8"), "UPDATED");
  // knowledge state persisted on meta
  const meta = await threadMgr.getThread(thread.id);
  assert.ok(meta.knownFiles.some((p) => p.endsWith("existing.txt")));
});

test("Write to a brand-new file needs no prior Read", async () => {
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "dev", agentDef: { name: "dev", tools: ["Write"] } });
  const { sandbox, registry, profile } = setup({ Write: "allow" });

  const chat = fakeChat([
    toolCall("w1", "Write", { path: "new.txt", content: "fresh" }),
    finalMessage("created"),
  ]);
  await runThread({ thread, threadMgr, sandbox, registry, profile, chat, userMessage: "create it" });

  assert.equal(existsSync(join(projectCwd, "new.txt")), true);
  assert.equal(readFileSync(join(projectCwd, "new.txt"), "utf8"), "fresh");
});

test("a full Read of a large file is redirected toward Grep/slicing", async () => {
  // > 128 KiB so it trips the size gate.
  writeFileSync(join(projectCwd, "big.txt"), "x".repeat(200 * 1024));
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "dev", agentDef: { name: "dev", tools: ["Read"] } });
  const { sandbox, registry, profile } = setup({ Read: "allow" });

  const chat = fakeChat([
    toolCall("r1", "Read", { path: "big.txt" }),
    finalMessage("ok"),
  ]);
  await runThread({ thread, threadMgr, sandbox, registry, profile, chat, userMessage: "read big" });

  const history = await threadMgr.readMessages(thread.id);
  const res = lastToolResult(history, "r1");
  assert.match(res.content, /Workflow:.*large/i);
  // a blocked read must NOT have dumped the file content
  assert.equal(res.content.includes("xxxxxxxxxx"), false);
});

test("a sliced Read of a large file is allowed", async () => {
  writeFileSync(join(projectCwd, "big.txt"), Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n"));
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "dev", agentDef: { name: "dev", tools: ["Read"] } });
  const { sandbox, registry, profile } = setup({ Read: "allow" });

  const chat = fakeChat([
    toolCall("r1", "Read", { path: "big.txt", start_line: 10, end_line: 20 }),
    finalMessage("ok"),
  ]);
  await runThread({ thread, threadMgr, sandbox, registry, profile, chat, userMessage: "read a slice" });

  const history = await threadMgr.readMessages(thread.id);
  const res = lastToolResult(history, "r1");
  assert.doesNotMatch(res.content, /Workflow:/);
  assert.match(res.content, /line 10/);
});
