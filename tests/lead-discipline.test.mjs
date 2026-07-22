// node:test coverage for the ADR 0015 lead-side CLI discipline:
//   - buildShowView: the token-lean structural view (heavy fields stripped,
//     recent content capped, card + trace stats surfaced);
//   - decideWaitOutcome: collecting a finished thread's distilled answer;
//   - the CLI wiring end-to-end via child-process invocation (the show cap
//     path, the wait immediate-collect path, and the --wait rejection).
//
// The two decision functions are exported from bin/agnz.mjs and imported
// directly (the CLI's main() is guarded behind an entrypoint check, so the
// import has no side effects). The wiring tests shell out to the real CLI
// against a fixture workspace built with the thread manager.
//
// Run with: node --test tests/lead-discipline.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildShowView, decideWaitOutcome, resolveTarget, lastToolActivity } from "../bin/agnz.mjs";
import { createThreadManager } from "../lib/threads.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "..", "bin", "agnz.mjs");

// ── buildShowView (pure) ─────────────────────────────────────────────────────

test("buildShowView strips the heavy embedded fields", () => {
  const thread = {
    id: "t1",
    name: "dev",
    status: "idle",
    cwd: "/proj",
    // These two are exactly what must NOT reach the lead's context.
    systemPromptSnapshot: "x".repeat(50000),
    agentDef: {
      name: "dev",
      description: "Implements features\nand fixes bugs",
      tools: ["Read", "Grep", "Edit"],
      disallowedTools: ["Bash"],
      body: "y".repeat(50000),
      prompt: "z".repeat(50000),
    },
  };
  const view = buildShowView(thread, [], null);
  const json = JSON.stringify(view);
  assert.doesNotMatch(json, /x{100}/, "systemPromptSnapshot must be absent");
  assert.doesNotMatch(json, /y{100}/, "agentDef.body must be absent");
  assert.doesNotMatch(json, /z{100}/, "agentDef.prompt must be absent");
  // agentDef reduced to its policy-relevant identity, description first line only
  assert.deepEqual(view.thread.agentDef, {
    name: "dev",
    description: "Implements features",
    tools: ["Read", "Grep", "Edit"],
    disallowedTools: ["Bash"],
  });
});

test("buildShowView caps each recent message's content with a size-reporting marker", () => {
  const big = "A".repeat(48 * 1024); // 48 KiB tool result
  const thread = { id: "t1", name: "dev", status: "idle", cwd: "/proj", agentDef: null };
  const view = buildShowView(
    thread,
    [
      { role: "user", content: "small" },
      { role: "tool", tool_call_id: "c1", content: big },
    ],
    null,
  );
  const small = view.recent[0];
  const capped = view.recent[1];
  assert.equal(small.content, "small", "a short message is untouched");
  assert.ok(capped.content.length < big.length, "the big message is truncated");
  assert.match(capped.content, /…\[elided, 48\.0 KB total\]$/);
  // structural fields survive the cap
  assert.equal(capped.role, "tool");
  assert.equal(capped.tool_call_id, "c1");
});

test("buildShowView keeps only the last 6 messages", () => {
  const msgs = Array.from({ length: 10 }, (_, i) => ({ role: "user", content: `m${i}` }));
  const view = buildShowView({ id: "t1", status: "idle" }, msgs, null);
  assert.equal(view.recent.length, 6);
  assert.equal(view.recent[0].content, "m4");
});

test("buildShowView passes through an assistant message with null content (tool_calls only)", () => {
  const view = buildShowView({ id: "t1", status: "running" }, [
    { role: "assistant", content: null, tool_calls: [{ id: "c1" }] },
  ], null);
  assert.equal(view.recent[0].content, null);
  assert.deepEqual(view.recent[0].tool_calls, [{ id: "c1" }]);
});

test("buildShowView surfaces the resume card when present, omits it otherwise", () => {
  const withCard = buildShowView(
    { id: "t1", status: "idle", card: { task: "do a thing", turns: 3, tokens: 900, ctxTokens: 12345 } },
    [],
    null,
  );
  assert.deepEqual(withCard.thread.card, { task: "do a thing", turns: 3, tokens: 900, ctxTokens: 12345 });

  const noCard = buildShowView({ id: "t2", status: "idle" }, [], null);
  assert.ok(!("card" in noCard.thread));
});

test("buildShowView attaches stats only when provided", () => {
  const stats = { turns: 5, tokens: { total: 100 } };
  assert.deepEqual(buildShowView({ id: "t1", status: "idle" }, [], stats).stats, stats);
  assert.ok(!("stats" in buildShowView({ id: "t1", status: "idle" }, [], null)));
});

// ── decideWaitOutcome (pure) ─────────────────────────────────────────────────

test("lastToolActivity picks the most recent tool_call and computes agoMs", () => {
  const now = 1_000_000;
  const a = lastToolActivity(
    [
      { ts: 1000, type: "thread_start" },
      { ts: 2000, type: "tool_call", name: "Read", target: "a.mjs", outcome: "ok" },
      { ts: 3000, type: "llm_call", usage: { total: 10 } },
      { ts: 4000, type: "tool_call", name: "Write", target: "b.mjs", outcome: "ok" },
    ],
    now,
  );
  assert.deepEqual(a, { name: "Write", target: "b.mjs", outcome: "ok", ts: 4000, agoMs: 996_000 });
});

test("lastToolActivity is null on an empty or tool-less trace", () => {
  assert.equal(lastToolActivity([]), null);
  assert.equal(lastToolActivity(null), null);
  assert.equal(
    lastToolActivity([
      { ts: 1, type: "thread_start" },
      { ts: 2, type: "llm_call", usage: { total: 10 } },
    ]),
    null,
  );
});

test("lastToolActivity tolerates a target-less tool_call (field simply absent)", () => {
  const a = lastToolActivity([{ ts: 5, type: "tool_call", name: "SendMessage", outcome: "ok" }], 10);
  assert.deepEqual(a, { name: "SendMessage", outcome: "ok", ts: 5, agoMs: 5 });
});

test("decideWaitOutcome returns the last assistant answer on an idle thread", () => {
  const o = decideWaitOutcome({ id: "t1", status: "idle", summary: "done", pending: null }, [
    { role: "user", content: "task" },
    { role: "assistant", content: "first" },
    { role: "tool", tool_call_id: "c1", content: "result" },
    { role: "assistant", content: "the distilled final answer" },
  ]);
  assert.deepEqual(o, {
    thread_id: "t1",
    status: "idle",
    summary: "done",
    pending: null,
    content: "the distilled final answer",
  });
});

test("decideWaitOutcome does not cap the collected content (full payload)", () => {
  const big = "Z".repeat(20000);
  const o = decideWaitOutcome({ id: "t1", status: "idle" }, [{ role: "assistant", content: big }]);
  assert.equal(o.content, big);
});

test("decideWaitOutcome omits content for a still-running thread", () => {
  const o = decideWaitOutcome({ id: "t1", status: "running", summary: null, pending: null }, null);
  assert.ok(!("content" in o));
  assert.equal(o.status, "running");
});

test("decideWaitOutcome surfaces pending on an awaiting_input thread", () => {
  const pending = { kind: "question", toolCallId: "c1", question: "which file?" };
  const o = decideWaitOutcome({ id: "t1", status: "awaiting_input", pending }, null);
  assert.deepEqual(o.pending, pending);
  assert.ok(!("content" in o));
});

test("decideWaitOutcome surfaces the error on an error thread", () => {
  const err = { message: "runner process is gone" };
  const o = decideWaitOutcome({ id: "t1", status: "error", error: err }, null);
  assert.deepEqual(o.error, err);
});

// ── capPending: pending.args must not leak uncapped (finding B) ───────────────

test("show caps a fat pending.args while keeping structural fields intact", () => {
  const big = "W".repeat(50 * 1024); // 50 KiB Write content in the pause payload
  const pending = {
    toolCallId: "call-1",
    kind: "approval",
    name: "Write",
    args: { path: "big.txt", content: big },
  };
  const view = buildShowView({ id: "t1", status: "awaiting_input", pending }, [], null);
  const p = view.thread.pending;
  assert.match(p.args.content, /…\[elided, 50\.0 KB total\]$/);
  assert.ok(p.args.content.length < big.length, "the fat arg is truncated");
  assert.equal(p.args.path, "big.txt", "short args pass through untouched");
  // Structural fields survive intact so the lead can still act.
  assert.equal(p.toolCallId, "call-1");
  assert.equal(p.kind, "approval");
  assert.equal(p.name, "Write");
});

test("wait caps a fat pending.args too (same helper, both surfaces)", () => {
  const big = "E".repeat(50 * 1024);
  const pending = {
    toolCallId: "c2",
    kind: "approval",
    name: "Edit",
    args: { path: "f.js", old_string: big, new_string: "small" },
  };
  const o = decideWaitOutcome({ id: "t1", status: "awaiting_input", summary: null, pending }, null);
  assert.match(o.pending.args.old_string, /…\[elided, 50\.0 KB total\]$/);
  assert.equal(o.pending.args.new_string, "small");
  assert.equal(o.pending.toolCallId, "c2");
  assert.equal(o.pending.name, "Edit");
});

test("capPending leaves a small question-pause pending fully intact", () => {
  const pending = {
    toolCallId: "c3",
    kind: "question",
    question: "Which config file?",
    options: ["a.json", "b.json"],
    context: "found two candidates",
  };
  const view = buildShowView({ id: "t1", status: "awaiting_input", pending }, [], null);
  assert.deepEqual(view.thread.pending, pending);
});

// ── CLI wiring (child-process against a fixture workspace) ────────────────────

let userDir;
let cwd;

beforeEach(() => {
  userDir = mkdtempSync(join(tmpdir(), "agnz-lead-user-"));
  cwd = mkdtempSync(join(tmpdir(), "agnz-lead-cwd-"));
  process.env.AGNZ_DATA_DIR = userDir;
});

afterEach(() => {
  delete process.env.AGNZ_DATA_DIR;
  rmSync(userDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

// Run the CLI as a child process, inheriting AGNZ_DATA_DIR so it resolves the
// same thread index the fixture was built under. Returns parsed stdout JSON.
function runCli(args) {
  const stdout = execFileSync(process.execPath, [CLI, ...args, "--cwd", cwd], {
    env: { ...process.env, AGNZ_DATA_DIR: userDir },
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

async function seedIdleThread(id_out) {
  const tm = createThreadManager();
  const agentDef = {
    name: "dev",
    description: "Implements features",
    tools: ["Read", "Grep", "Edit"],
    body: "HEAVY BODY ".repeat(5000),
  };
  const thread = await tm.createThread({ cwd, agentDef, name: "dev" });
  // Oversized tool result + the distilled final answer.
  await tm.appendMessage(thread.id, { role: "user", content: "do the task" });
  await tm.appendMessage(thread.id, { role: "tool", tool_call_id: "c1", content: "B".repeat(40000) });
  await tm.appendMessage(thread.id, { role: "assistant", content: "final answer from the agent" });
  // Stamp the heavy meta fields ADR 0015 says show must strip, then finish.
  await tm.updateThread(thread.id, {
    systemPromptSnapshot: "S".repeat(30000),
    card: { task: "do the task", turns: 2, tokens: 500, ctxTokens: 1234 },
  });
  await tm.setStatus(thread.id, "idle", { summary: "task complete", pending: null });
  return thread.id;
}

test("show returns a lean view: heavy fields stripped, recent capped, card kept", async () => {
  const id = await seedIdleThread();
  const raw = execFileSync(process.execPath, [CLI, "show", id, "--cwd", cwd], {
    env: { ...process.env, AGNZ_DATA_DIR: userDir },
    encoding: "utf8",
  });
  // Parseable JSON contract, and the heavy fields never appear in the bytes.
  assert.doesNotMatch(raw, /SSSSSSSSSS/, "systemPromptSnapshot must not be in show output");
  assert.doesNotMatch(raw, /HEAVY BODY/, "agentDef body must not be in show output");
  const view = JSON.parse(raw);
  assert.equal(view.thread.status, "idle");
  assert.deepEqual(view.thread.agentDef, {
    name: "dev",
    description: "Implements features",
    tools: ["Read", "Grep", "Edit"],
    disallowedTools: null,
  });
  assert.equal(view.thread.card.task, "do the task");
  // the 40 KB tool result is capped with the elision marker
  const tool = view.recent.find((m) => m.role === "tool");
  assert.match(tool.content, /…\[elided, [\d.]+ KB total\]$/);
});

test("wait collects a finished thread's answer immediately (no runner)", async () => {
  const id = await seedIdleThread();
  const outcome = runCli(["wait", id]);
  assert.equal(outcome.thread_id, id);
  assert.equal(outcome.status, "idle");
  assert.equal(outcome.content, "final answer from the agent");
  assert.equal(outcome.summary, "task complete");
});

test("wait resolves by agent name, not just id", async () => {
  await seedIdleThread();
  const outcome = runCli(["wait", "dev"]);
  assert.equal(outcome.status, "idle");
  assert.equal(outcome.content, "final answer from the agent");
});

// ── resolveTarget wait-inclusive resolution (finding D) ──────────────────────
// Placed inside the wiring section so the beforeEach fixture (cwd + AGNZ_DATA_DIR)
// is active — these hit the real thread manager.

test("resolveTarget with includeError resolves an errored thread by name; default excludes it", async () => {
  const tm = createThreadManager();
  const crashed = await tm.createThread({ cwd, name: "crashy" });
  await tm.setStatus(crashed.id, "error", { error: { message: "boom" } });

  // send's default resolution refuses the errored thread (start fresh instead).
  assert.equal(await resolveTarget(tm, cwd, "crashy"), null);
  // wait's resolution collects it — the crash outcome is what the waiter wants.
  const found = await resolveTarget(tm, cwd, "crashy", { includeError: true });
  assert.equal(found?.id, crashed.id);
});

test("resolveTarget prefers the most recently updated match when a name is shared", async () => {
  const tm = createThreadManager();
  const older = await tm.createThread({ cwd, name: "dup" });
  await tm.setStatus(older.id, "error", { error: { message: "old" } });
  const newer = await tm.createThread({ cwd, name: "dup" });
  await tm.setStatus(newer.id, "error", { error: { message: "new" } });
  const found = await resolveTarget(tm, cwd, "dup", { includeError: true });
  assert.equal(found?.id, newer.id, "the newer errored thread wins");
});

test("wait <name> collects a crashed thread that only exists in error state (finding D)", async () => {
  const tm = createThreadManager();
  const crashed = await tm.createThread({ cwd, name: "onlyerror" });
  await tm.setStatus(crashed.id, "error", { error: { message: "runner died" } });
  const outcome = runCli(["wait", "onlyerror"]);
  assert.equal(outcome.thread_id, crashed.id);
  assert.equal(outcome.status, "error");
  assert.equal(outcome.error.message, "runner died");
});

// ── capMessageContent handles content-parts arrays (finding E) ───────────────

test("buildShowView caps a big text part inside an array content message", () => {
  const big = "P".repeat(48 * 1024);
  const view = buildShowView({ id: "t1", status: "idle" }, [
    {
      role: "tool",
      tool_call_id: "c1",
      content: [
        { type: "text", text: big },
        { type: "text", text: "short tail" },
      ],
    },
  ], null);
  const parts = view.recent[0].content;
  assert.match(parts[0].text, /…\[elided, 48\.0 KB total\]$/);
  assert.equal(parts[1].text, "short tail");
  assert.equal(view.recent[0].role, "tool");
});

test("--wait on start/send fails with a pointer to the wait verb", () => {
  // execFileSync throws on a non-zero exit; the error carries stdout.
  let stdout = "";
  try {
    execFileSync(process.execPath, [CLI, "start", "dev", "task", "--agent", "dev", "--wait", "--cwd", cwd], {
      env: { ...process.env, AGNZ_DATA_DIR: userDir },
      encoding: "utf8",
    });
    assert.fail("expected --wait to be rejected");
  } catch (err) {
    stdout = err.stdout || "";
  }
  const parsed = JSON.parse(stdout);
  assert.match(parsed.error, /--wait was removed/);
  assert.match(parsed.error, /agnz wait <id>/);
});
