// node:test coverage for ADR 0012 phase 1: the frozen system-prompt prefix.
//
// Two guarantees:
//   1. The system prompt is byte-identical every turn (snapshot reused), so it
//      no longer grows and the inference server can cache the prefix.
//   2. A visited subdirectory's CLAUDE.md is injected ONCE into history (not
//      re-templated into the system prompt every turn), and only once even if
//      the agent works in that directory across several turns.
//
// Run with: node --test tests/context-prefix.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
  projectCwd = mkdtempSync(join(tmpdir(), "agnz-prefix-cwd-"));
  userDir = mkdtempSync(join(tmpdir(), "agnz-prefix-user-"));
  process.env.AGNZ_DATA_DIR = userDir;
  // A subdirectory with its own CLAUDE.md and a file to read.
  mkdirSync(join(projectCwd, "sub"), { recursive: true });
  writeFileSync(join(projectCwd, "sub", "CLAUDE.md"), "SUBDIR RULES: be careful here.");
  writeFileSync(join(projectCwd, "sub", "data.txt"), "payload");
});

afterEach(() => {
  delete process.env.AGNZ_DATA_DIR;
  rmSync(projectCwd, { recursive: true, force: true });
  rmSync(userDir, { recursive: true, force: true });
});

function readTrace(cwd, id) {
  const f = join(cwd, ".claude", "agnz", "threads", `${id}.trace.jsonl`);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("system prompt is byte-stable across turns and excludes subdir CLAUDE.md", async () => {
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "dev", agentDef: { name: "dev", tools: ["Read"] } });
  const sandbox = createSandbox({ root: projectCwd, policy: { Read: "allow" } });
  const registry = createRegistry();
  const profile = { baseUrl: "http://fake", model: "fake", name: "p" };

  // Turn 0 reads a file in sub/, turn 1 finishes.
  const chat = fakeChat([
    toolCall("c1", "Read", { path: "sub/data.txt" }),
    finalMessage("done"),
  ]);

  const outcome = await runThread({ thread, threadMgr, sandbox, registry, profile, chat, userMessage: "read it" });
  assert.equal(outcome.status, "final");

  // Every system-prompt snapshot recorded in the trace must be identical.
  const trace = readTrace(projectCwd, thread.id);
  const prompts = trace
    .filter((e) => e.type === "thread_start" || e.type === "turn_start")
    .map((e) => e.systemPrompt);
  assert.ok(prompts.length >= 2, "expected a thread_start and a turn_start");
  for (const p of prompts) assert.equal(p, prompts[0], "system prompt drifted between turns");

  // The subdir CLAUDE.md must NOT be in the (frozen) system prompt...
  assert.doesNotMatch(prompts[0], /SUBDIR RULES/);

  // ...it must be injected once into history as a user message instead.
  const history = await threadMgr.readMessages(thread.id);
  const ctxMsgs = history.filter((m) => m.role === "user" && /Project context for directories/.test(m.content || ""));
  assert.equal(ctxMsgs.length, 1, "subdir CLAUDE.md injected exactly once");
  assert.match(ctxMsgs[0].content, /SUBDIR RULES/);
});

test("a subdir CLAUDE.md is injected only once even across repeated visits", async () => {
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "dev", agentDef: { name: "dev", tools: ["Read"] } });
  const sandbox = createSandbox({ root: projectCwd, policy: { Read: "allow" } });
  const registry = createRegistry();
  const profile = { baseUrl: "http://fake", model: "fake", name: "p" };

  // Read in sub/ on two separate turns; the CLAUDE.md should still inject once.
  const chat = fakeChat([
    toolCall("c1", "Read", { path: "sub/data.txt" }),
    toolCall("c2", "Read", { path: "sub/data.txt" }),
    finalMessage("done"),
  ]);

  await runThread({ thread, threadMgr, sandbox, registry, profile, chat, userMessage: "read twice" });

  const history = await threadMgr.readMessages(thread.id);
  const ctxMsgs = history.filter((m) => m.role === "user" && /SUBDIR RULES/.test(m.content || ""));
  assert.equal(ctxMsgs.length, 1);
});

test("the snapshot is persisted on thread meta after the first run", async () => {
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "dev", agentDef: { name: "dev", tools: ["Read"] } });
  const sandbox = createSandbox({ root: projectCwd, policy: { Read: "allow" } });
  const registry = createRegistry();
  const profile = { baseUrl: "http://fake", model: "fake", name: "p" };

  await runThread({ thread, threadMgr, sandbox, registry, profile, chat: fakeChat([finalMessage("ok")]), userMessage: "hi" });

  const meta = await threadMgr.getThread(thread.id);
  assert.equal(typeof meta.systemPromptSnapshot, "string");
  assert.ok(meta.systemPromptSnapshot.length > 0);
});
