// node:test coverage for the resume-card (feat/resume-card).
//
// The loop stamps a compact `card` { task, turns, tokens, ctxTokens } onto the
// thread meta at every pause/finish so the hooks can read reuse-relevant spend
// without folding the trace. These tests drive the real loop with the shared
// fake LLM (ctx.chat) and assert the card's shape, its cross-run accumulation,
// and that the mission `task` is stamped once and never overwritten.
//
// Run with: node --test tests/resume-card.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  projectCwd = mkdtempSync(join(tmpdir(), "agnz-card-cwd-"));
  userDir = mkdtempSync(join(tmpdir(), "agnz-card-user-"));
  process.env.AGNZ_DATA_DIR = userDir;
  writeFileSync(join(projectCwd, "hello.txt"), "hi from the sandbox\n");
});

afterEach(() => {
  delete process.env.AGNZ_DATA_DIR;
  rmSync(projectCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function withUsage(step, prompt, total) {
  return { ...step, usage: { prompt_tokens: prompt, completion_tokens: total - prompt, total_tokens: total } };
}

function setup() {
  const threadMgr = createThreadManager();
  const sandbox = createSandbox({ root: projectCwd, policy: { LS: "allow" } });
  const registry = createRegistry();
  const profile = { baseUrl: "http://fake", model: "fake-model", name: "fake-profile" };
  return { threadMgr, sandbox, registry, profile };
}

test("a finished run stamps a card with task, turns, tokens, and ctxTokens", async () => {
  const { threadMgr, sandbox, registry, profile } = setup();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "tracer", agentDef: { name: "tracer" } });

  // Turn 0 calls a tool (prompt 10, total 14); turn 1 is the final answer
  // (prompt 20, total 26). ctxTokens must be the LAST prompt (20), not a sum.
  const chat = fakeChat([
    withUsage(toolCall("call_1", "LS", { path: "." }), 10, 14),
    withUsage(finalMessage("Done."), 20, 26),
  ]);

  const outcome = await runThread({
    thread, threadMgr, sandbox, registry, profile, chat,
    userMessage: "List the sandbox root.",
  });
  assert.equal(outcome.status, "final");

  const meta = await threadMgr.getThread(thread.id);
  assert.ok(meta.card, "card is stamped on meta");
  assert.equal(meta.card.task, "List the sandbox root.");
  assert.equal(meta.card.turns, 2); // two llm_calls
  assert.equal(meta.card.tokens, 40); // 14 + 26
  assert.equal(meta.card.ctxTokens, 20); // last prompt, not the sum
});

test("card turns/tokens accumulate across a resume; ctxTokens is the last prompt", async () => {
  const { threadMgr, sandbox, registry, profile } = setup();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "tracer", agentDef: { name: "tracer" } });

  // Run 1: two turns (prompts 10, 20 · totals 14, 26).
  await runThread({
    thread, threadMgr, sandbox, registry, profile,
    chat: fakeChat([
      withUsage(toolCall("call_1", "LS", { path: "." }), 10, 14),
      withUsage(finalMessage("Done one."), 20, 26),
    ]),
    userMessage: "First mission line here.",
  });

  // Run 2: fresh reload (mirrors the runner), one turn (prompt 30 · total 35).
  const reloaded = await threadMgr.getThread(thread.id);
  await runThread({
    thread: reloaded, threadMgr, sandbox, registry, profile,
    chat: fakeChat([withUsage(finalMessage("Done two."), 30, 35)]),
    userMessage: "A different follow-up.",
  });

  const meta = await threadMgr.getThread(thread.id);
  assert.equal(meta.card.turns, 3); // 2 + 1
  assert.equal(meta.card.tokens, 75); // 40 + 35
  assert.equal(meta.card.ctxTokens, 30); // last prompt of run 2, NOT 20+30
  // task is stamped from the FIRST message and never overwritten by later ones
  assert.equal(meta.card.task, "First mission line here.");
});

test("card.task takes the first non-empty line, capped at 100 chars", async () => {
  const { threadMgr, sandbox, registry, profile } = setup();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "tracer", agentDef: { name: "tracer" } });

  const long = "x".repeat(150);
  await runThread({
    thread, threadMgr, sandbox, registry, profile,
    chat: fakeChat([withUsage(finalMessage("ok"), 5, 8)]),
    // leading blank lines: the first NON-empty line is the mission
    userMessage: `\n\n${long}\nsecond line`,
  });

  const meta = await threadMgr.getThread(thread.id);
  assert.equal(meta.card.task.length, 100);
  assert.equal(meta.card.task, long.slice(0, 100));
});

test("a pause (approval) stamps a card carrying spend so far", async () => {
  const { threadMgr, sandbox, registry, profile } = setup();
  // Write is not allow-listed (only LS is) → the call pauses for approval.
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "asker", agentDef: { name: "asker" } });

  const outcome = await runThread({
    thread, threadMgr, sandbox, registry, profile,
    chat: fakeChat([withUsage(toolCall("call_w", "Write", { path: "out.txt", content: "x" }), 12, 15)]),
    userMessage: "Write a file.",
  });
  assert.equal(outcome.status, "awaiting_input");

  const meta = await threadMgr.getThread(thread.id);
  assert.ok(meta.card, "card stamped at the pause");
  assert.equal(meta.card.task, "Write a file.");
  assert.equal(meta.card.turns, 1);
  assert.equal(meta.card.tokens, 15);
  assert.equal(meta.card.ctxTokens, 12);
});
