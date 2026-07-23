// node:test coverage for context compaction (context-diet 3/3).
//
// The steady state never mutates the transcript (cache stays warm); at the
// profile-declared window threshold the run pays one deliberate reset:
// summarize (ballast-stripped one-shot input), append a marker message, clear
// the knowledge state, and send only from the marker onwards.
//
// Run with: node --test tests/compaction.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createThreadManager } from "../lib/threads.mjs";
import { createSandbox } from "../lib/sandbox.mjs";
import { createRegistry } from "../lib/tools/registry.mjs";
import { runThread } from "../lib/loop.mjs";
import {
  shouldCompact,
  renderCompactionInput,
  renderRecentTail,
  buildCompactionMarker,
  COMPACTION_PROMPT,
} from "../lib/compaction.mjs";
import { fakeChat, toolCall, finalMessage } from "./_fake-llm.mjs";

let projectCwd;
let userDir;

beforeEach(() => {
  projectCwd = mkdtempSync(join(tmpdir(), "agnz-compact-cwd-"));
  userDir = mkdtempSync(join(tmpdir(), "agnz-compact-user-"));
  process.env.AGNZ_DATA_DIR = userDir;
  writeFileSync(join(projectCwd, "data.txt"), "the payload");
});

afterEach(() => {
  delete process.env.AGNZ_DATA_DIR;
  rmSync(projectCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function readTrace(cwd, id) {
  const f = join(cwd, ".claude", "agnz", "threads", `${id}.trace.jsonl`);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// A chat double that records every request it receives, replaying a script.
function recordingChat(script, calls) {
  const inner = fakeChat(script);
  return async (req) => {
    calls.push(req);
    return inner(req);
  };
}

// ---- unit: shouldCompact ----------------------------------------------------

test("shouldCompact is inert without a declared contextWindow", () => {
  assert.equal(shouldCompact({ lastPromptTokens: 999999, profile: {} }), false);
  assert.equal(shouldCompact({ lastPromptTokens: 999999, profile: { contextWindow: null } }), false);
});

test("shouldCompact fires at the threshold, not below", () => {
  const profile = { contextWindow: 1000 };
  assert.equal(shouldCompact({ lastPromptTokens: 899, profile }), false);
  assert.equal(shouldCompact({ lastPromptTokens: 900, profile }), true);
  assert.equal(shouldCompact({ lastPromptTokens: null, profile }), false);
});

test("shouldCompact honours a custom compactThreshold", () => {
  const profile = { contextWindow: 1000, compactThreshold: 0.5 };
  assert.equal(shouldCompact({ lastPromptTokens: 499, profile }), false);
  assert.equal(shouldCompact({ lastPromptTokens: 500, profile }), true);
});

// ---- unit: renderCompactionInput -------------------------------------------

test("renderCompactionInput stubs large Write arguments down to the path", () => {
  const bigContent = "x".repeat(5000);
  const history = [
    { role: "user", content: "build the thing" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "Write", arguments: JSON.stringify({ path: "lib/big.py", content: bigContent }) },
        },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: "Wrote lib/big.py" },
  ];
  const input = renderCompactionInput(history);
  assert.match(input, /build the thing/);
  assert.match(input, /Write\(\{path: "lib\/big\.py", args elided — \d+ chars\}\)/);
  assert.equal(input.includes(bigContent), false, "file content must not reach the summarizer");
});

test("renderCompactionInput caps tool results and starts from a prior marker", () => {
  const history = [
    { role: "user", content: "PRE-MARKER TASK" },
    { role: "user", _compact: true, content: "EARLIER SUMMARY TEXT" },
    { role: "user", content: "post-marker follow-up" },
    { role: "tool", tool_call_id: "t1", content: "y".repeat(2000) },
  ];
  const input = renderCompactionInput(history);
  assert.equal(input.includes("PRE-MARKER TASK"), false, "pre-marker history is already summarized");
  assert.match(input, /earlier summary — from a previous compaction/);
  assert.match(input, /EARLIER SUMMARY TEXT/);
  assert.match(input, /\[\+\d+ more chars\]/);
});

test("buildCompactionMarker is a user message flagged _compact", () => {
  const marker = buildCompactionMarker("THE SUMMARY");
  assert.equal(marker.role, "user");
  assert.equal(marker._compact, true);
  assert.match(marker.content, /Context compacted/);
  assert.match(marker.content, /THE SUMMARY/);
  assert.match(marker.content, /Read them again/);
  assert.doesNotMatch(marker.content, /last exchanges/, "no tail section without a tail");
});

test("the recent tail rides inside the marker as text, capped", () => {
  const tail = renderRecentTail([
    { role: "user", content: "way earlier — must not appear" },
    { role: "assistant", content: "working on step 4" },
    { role: "tool", tool_call_id: "t1", content: "z".repeat(5000) },
    { role: "assistant", content: "step 4 done, starting step 5" },
  ]);
  assert.equal(tail.includes("way earlier"), false, "only the last three messages");
  assert.match(tail, /working on step 4/);
  assert.match(tail, /starting step 5/);
  assert.match(tail, /\[\+\d+ more chars\]/, "huge tool result capped");

  const marker = buildCompactionMarker("SUM", tail);
  assert.match(marker.content, /last exchanges just before the compaction/);
  assert.match(marker.content, /starting step 5/);
});

// ---- integration: the loop compacts at the threshold ------------------------

test("crossing the window threshold summarizes, marks, resets, and restarts the wire payload", async () => {
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "dev", agentDef: { name: "dev", tools: ["Read"] } });
  const sandbox = createSandbox({ root: projectCwd, policy: { Read: "allow" } });
  const registry = createRegistry();
  const profile = { baseUrl: "http://fake", model: "fake", name: "p", contextWindow: 1000 };

  const calls = [];
  // Call 1: agent turn with near-full usage. Call 2 is consumed by the
  // summarizer. Call 3: the agent's first post-compaction turn.
  const chat = recordingChat(
    [
      { ...toolCall("c1", "Read", { path: "data.txt" }), usage: { prompt_tokens: 950, completion_tokens: 10, total_tokens: 960 } },
      finalMessage("SUMMARY: read data.txt; nothing left to do."),
      finalMessage("done"),
    ],
    calls,
  );

  const outcome = await runThread({ thread, threadMgr, sandbox, registry, profile, chat, userMessage: "read it" });
  assert.equal(outcome.status, "final");
  assert.equal(calls.length, 3);

  // The summarize call: compaction prompt as system, no tools, ballast capped.
  const sumCall = calls[1];
  assert.equal(sumCall.messages[0].content, COMPACTION_PROMPT);
  assert.equal(sumCall.tools, undefined);
  assert.match(sumCall.messages[1].content, /read it/);

  // The marker sits in the transcript; the knowledge state is reset.
  const history = await threadMgr.readMessages(thread.id);
  const markers = history.filter((m) => m._compact);
  assert.equal(markers.length, 1);
  assert.match(markers[0].content, /SUMMARY: read data\.txt/);
  // Continuity: the last exchanges (the Read call + its result) ride inside
  // the marker as text — not as separate messages.
  assert.match(markers[0].content, /last exchanges just before the compaction/);
  assert.match(markers[0].content, /the payload/);
  const meta = await threadMgr.getThread(thread.id);
  assert.deepEqual(meta.knownFiles, []);
  assert.deepEqual(meta.fileStamps, {});
  assert.deepEqual(meta.visitedDirs, []);

  // The post-compaction agent call starts from the marker: system + marker
  // only — the original task and the Read result are no longer on the wire,
  // and the internal _compact flag does not leak to the server.
  const postCall = calls[2];
  assert.equal(postCall.messages.length, 2);
  assert.equal(postCall.messages[0].role, "system");
  assert.match(postCall.messages[1].content, /Context compacted/);
  assert.equal(postCall.messages[1]._compact, undefined);

  // Traced with sizes.
  const compactions = readTrace(projectCwd, thread.id).filter((e) => e.type === "compaction");
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].outcome, "ok");
  assert.ok(compactions[0].inputChars > 0);
});

test("a resumed thread near the window compacts before its first LLM call (card seed)", async () => {
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "dev", agentDef: { name: "dev", tools: ["Read"] } });
  await threadMgr.appendMessage(thread.id, { role: "user", content: "old task" });
  await threadMgr.appendMessage(thread.id, { role: "assistant", content: "old answer" });
  await threadMgr.updateThread(thread.id, { card: { task: "old task", turns: 5, tokens: 5000, ctxTokens: 950 } });

  const sandbox = createSandbox({ root: projectCwd, policy: { Read: "allow" } });
  const registry = createRegistry();
  const profile = { baseUrl: "http://fake", model: "fake", name: "p", contextWindow: 1000 };

  const calls = [];
  const chat = recordingChat(
    [finalMessage("SUMMARY of the old work."), finalMessage("continuing")],
    calls,
  );
  const fresh = await threadMgr.getThread(thread.id);
  const outcome = await runThread({ thread: fresh, threadMgr, sandbox, registry, profile, chat, userMessage: "follow up" });
  assert.equal(outcome.status, "final");

  // First chat call is the summarizer, second is the (compacted) agent turn.
  assert.equal(calls[0].messages[0].content, COMPACTION_PROMPT);
  const agentCall = calls[1];
  // The old history is off the wire as MESSAGES (system + marker only); its
  // last exchanges may legitimately appear as text inside the marker.
  assert.equal(agentCall.messages.length, 2);
  assert.equal(agentCall.messages.filter((m) => m.role === "assistant").length, 0);
  assert.match(agentCall.messages[1].content, /Context compacted/);
});

test("a failed summarize call degrades to no compaction and does not retry this run", async () => {
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "dev", agentDef: { name: "dev", tools: ["Read"] } });
  const sandbox = createSandbox({ root: projectCwd, policy: { Read: "allow" } });
  const registry = createRegistry();
  const profile = { baseUrl: "http://fake", model: "fake", name: "p", contextWindow: 1000 };

  const calls = [];
  // Call 1: near-full usage. Call 2: summarizer returns EMPTY → failure.
  // Call 3: the run continues uncompacted; usage stays near-full, but the
  // failure must not trigger a second attempt this run.
  const chat = recordingChat(
    [
      { ...toolCall("c1", "Read", { path: "data.txt" }), usage: { prompt_tokens: 950, completion_tokens: 10, total_tokens: 960 } },
      finalMessage(""),
      { ...toolCall("c2", "Read", { path: "data.txt", start_line: 1, end_line: 1 }), usage: { prompt_tokens: 960, completion_tokens: 10, total_tokens: 970 } },
      finalMessage("done"),
    ],
    calls,
  );

  const outcome = await runThread({ thread, threadMgr, sandbox, registry, profile, chat, userMessage: "read it" });
  assert.equal(outcome.status, "final");

  const history = await threadMgr.readMessages(thread.id);
  assert.equal(history.filter((m) => m._compact).length, 0, "no marker on failure");
  const compactions = readTrace(projectCwd, thread.id).filter((e) => e.type === "compaction");
  assert.equal(compactions.length, 1, "exactly one attempt per run after a failure");
  assert.equal(compactions[0].outcome, "error");
  // 4 calls total: turn, failed summarize, turn, final — no second summarize.
  assert.equal(calls.length, 4);

  // ADR 0019 §7: the failure reaches the lead through the one channel — an
  // agnz-sender error in messages.jsonl, not just a trace entry. The publish
  // is fire-and-forget, so poll briefly instead of asserting immediately.
  const { readAllMessages } = await import("../lib/messages-log.mjs");
  let sys = [];
  for (let i = 0; i < 40 && sys.length === 0; i++) {
    sys = (await readAllMessages(projectCwd)).filter((m) => m.from === "agnz" && m.kind === "error");
    if (sys.length === 0) await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(sys.length, 1, "compaction failure published as from:'agnz'");
  assert.match(sys[0].text, /compaction failed/);
  assert.deepEqual(sys[0].to, "parent");
});
