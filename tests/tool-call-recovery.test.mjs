// node:test coverage for textual tool-call recovery.
//
// Local models leak their native tool-call syntax as plain text when the
// server's template parser misses it (observed: devstral-2 under Ollama
// emitting `Read[ARGS]{...}` as content). These tests pin both halves of
// the defense: the pure parser (lib/tool-call-recovery.mjs) and the loop
// integration (recover → dispatch; unparseable attempt → bounded nudge).
//
// Run with: node --test tests/tool-call-recovery.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  recoverTextualToolCalls,
  TEXTUAL_TOOL_CALL_NUDGE,
} from "../lib/tool-call-recovery.mjs";
import { createThreadManager } from "../lib/threads.mjs";
import { createSandbox } from "../lib/sandbox.mjs";
import { createRegistry } from "../lib/tools/registry.mjs";
import { runThread } from "../lib/loop.mjs";
import { fakeChat, finalMessage } from "./_fake-llm.mjs";

const KNOWN = ["LS", "Read", "Grep", "Edit", "Write", "Bash"];

// --- parser ---------------------------------------------------------------

test("recovers the Mistral/Tekken leak observed in the wild", () => {
  const rec = recoverTextualToolCalls(
    'Read[ARGS]{"path":"docs/epics.md","start_line":6,"end_line":20}',
    KNOWN,
  );
  assert.equal(rec.toolCalls.length, 1);
  assert.equal(rec.toolCalls[0].function.name, "Read");
  assert.deepEqual(JSON.parse(rec.toolCalls[0].function.arguments), {
    path: "docs/epics.md",
    start_line: 6,
    end_line: 20,
  });
});

test("recovers with the [TOOL_CALLS] prefix and short surrounding prose", () => {
  const rec = recoverTextualToolCalls(
    'Let me check that file.\n[TOOL_CALLS]Grep[ARGS]{"pattern":"foo","path":"lib"}',
    KNOWN,
  );
  assert.equal(rec.toolCalls.length, 1);
  assert.equal(rec.toolCalls[0].function.name, "Grep");
});

test("recovers multiple sequential Tekken calls", () => {
  const rec = recoverTextualToolCalls(
    'LS[ARGS]{"path":"."}Read[ARGS]{"path":"a.txt"}',
    KNOWN,
  );
  assert.deepEqual(
    rec.toolCalls.map((c) => c.function.name),
    ["LS", "Read"],
  );
});

test("recovers nested braces inside string args", () => {
  const rec = recoverTextualToolCalls(
    'Write[ARGS]{"path":"x.json","content":"{\\"a\\": {\\"b\\": 1}}"}',
    KNOWN,
  );
  assert.equal(rec.toolCalls.length, 1);
  assert.equal(JSON.parse(rec.toolCalls[0].function.arguments).path, "x.json");
});

test("recovers the older Mistral array form", () => {
  const rec = recoverTextualToolCalls(
    '[TOOL_CALLS] [{"name": "Read", "arguments": {"path": "a.txt"}}]',
    KNOWN,
  );
  assert.equal(rec.toolCalls.length, 1);
  assert.equal(rec.toolCalls[0].function.name, "Read");
  assert.deepEqual(JSON.parse(rec.toolCalls[0].function.arguments), { path: "a.txt" });
});

test("recovers Hermes-style <tool_call> tags", () => {
  const rec = recoverTextualToolCalls(
    '<tool_call>{"name": "LS", "arguments": {"path": "."}}</tool_call>',
    KNOWN,
  );
  assert.equal(rec.toolCalls.length, 1);
  assert.equal(rec.toolCalls[0].function.name, "LS");
});

test("recovers a bare JSON call object (arguments or parameters)", () => {
  for (const key of ["arguments", "parameters"]) {
    const rec = recoverTextualToolCalls(
      JSON.stringify({ name: "Read", [key]: { path: "a.txt" } }),
      KNOWN,
    );
    assert.equal(rec.toolCalls.length, 1, `key: ${key}`);
    assert.equal(rec.toolCalls[0].function.name, "Read");
  }
});

test("unknown tool names never match", () => {
  const rec = recoverTextualToolCalls('Frobnicate[ARGS]{"x":1}', KNOWN);
  // [ARGS] marker present but nothing parseable-with-known-name → attempt
  assert.equal(rec.toolCalls.length, 0);
  assert.equal(rec.attempted, true);
});

test("a long document quoting call syntax is left alone", () => {
  const doc =
    "# Tool formats\n\nMistral emits calls like Read[ARGS]{\"path\":\"x\"} on the wire.\n" +
    "Below we document each field in detail so future readers understand the mapping.\n" +
    "x".repeat(400);
  assert.equal(recoverTextualToolCalls(doc, KNOWN), null);
});

test("plain prose is not an attempt", () => {
  assert.equal(recoverTextualToolCalls("All done. The module has 3 exports.", KNOWN), null);
  assert.equal(recoverTextualToolCalls("", KNOWN), null);
  assert.equal(recoverTextualToolCalls(null, KNOWN), null);
});

test("broken JSON after a marker is an attempt, not a recovery", () => {
  const rec = recoverTextualToolCalls('Read[ARGS]{"path": broken', KNOWN);
  assert.equal(rec.toolCalls.length, 0);
  assert.equal(rec.attempted, true);
});

// --- loop integration -----------------------------------------------------

let projectCwd;
let userDir;

beforeEach(() => {
  projectCwd = mkdtempSync(join(tmpdir(), "agnz-recov-cwd-"));
  userDir = mkdtempSync(join(tmpdir(), "agnz-recov-user-"));
  process.env.AGNZ_DATA_DIR = userDir;
});

afterEach(() => {
  delete process.env.AGNZ_DATA_DIR;
  rmSync(projectCwd, { recursive: true, force: true });
  rmSync(userDir, { recursive: true, force: true });
});

test("loop executes a text-leaked tool call instead of finishing", async () => {
  writeFileSync(join(projectCwd, "hello.txt"), "hello from disk");
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "dev", agentDef: { name: "dev" } });
  const chat = fakeChat([
    { message: { role: "assistant", content: 'Read[ARGS]{"path":"hello.txt"}' } },
    finalMessage("done"),
  ]);
  const sandbox = createSandbox({ root: projectCwd, policy: { Read: "allow" } });
  const registry = createRegistry();
  const profile = { baseUrl: "http://fake", model: "fake", name: "p" };

  const out = await runThread({ thread, threadMgr, sandbox, registry, profile, chat, userMessage: "read hello.txt" });
  assert.equal(out.status, "final");
  assert.equal(out.content, "done");

  const history = await threadMgr.readMessages(thread.id);
  const asst = history.find((m) => m.role === "assistant" && m.tool_calls);
  assert.ok(asst, "recovered tool_calls must be persisted on the assistant message");
  assert.equal(asst.tool_calls[0].function.name, "Read");
  const toolResult = history.find((m) => m.role === "tool");
  assert.match(toolResult.content, /hello from disk/);
});

test("loop nudges (bounded) on an unparseable attempt, then accepts the retry", async () => {
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "dev", agentDef: { name: "dev" } });
  const chat = fakeChat([
    { message: { role: "assistant", content: 'Read[ARGS]{"path": broken' } },
    finalMessage("final prose after nudge"),
  ]);
  const sandbox = createSandbox({ root: projectCwd, policy: { Read: "allow" } });
  const registry = createRegistry();
  const profile = { baseUrl: "http://fake", model: "fake", name: "p" };

  const out = await runThread({ thread, threadMgr, sandbox, registry, profile, chat, userMessage: "go" });
  assert.equal(out.status, "final");
  assert.equal(out.content, "final prose after nudge");

  const history = await threadMgr.readMessages(thread.id);
  const nudge = history.filter((m) => m.role === "user" && m.content === TEXTUAL_TOOL_CALL_NUDGE);
  assert.equal(nudge.length, 1, "exactly one corrective user message");
});

test("a plain prose final is untouched by the catcher", async () => {
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "dev", agentDef: { name: "dev" } });
  const chat = fakeChat([finalMessage("Done. Everything looks good.")]);
  const sandbox = createSandbox({ root: projectCwd, policy: {} });
  const registry = createRegistry();
  const profile = { baseUrl: "http://fake", model: "fake", name: "p" };

  const out = await runThread({ thread, threadMgr, sandbox, registry, profile, chat, userMessage: "report" });
  assert.equal(out.status, "final");
  const history = await threadMgr.readMessages(thread.id);
  assert.equal(history.filter((m) => m.content === TEXTUAL_TOOL_CALL_NUDGE).length, 0);
});
