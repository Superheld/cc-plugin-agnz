// node:test coverage for the harness-visibility fixes: the agent is told what
// the harness already enforces against it.
//
// Two guarantees:
//   1. Turn budget — the frozen prefix announces the total once on turn 0, so
//      the loop hands over the REMAINING count at a few marks. Without it the
//      prompt's own "finish the most valuable part" rule is unfollowable.
//   2. Layer independence — a thread without an agent def still gets the
//      sandbox framing and the tool policy note. It used to get neither while
//      the harness kept enforcing the rules those layers describe.
//
// Run with: node --test tests/harness-visibility.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
  projectCwd = mkdtempSync(join(tmpdir(), "agnz-visibility-cwd-"));
  userDir = mkdtempSync(join(tmpdir(), "agnz-visibility-user-"));
  process.env.AGNZ_DATA_DIR = userDir;
  writeFileSync(join(projectCwd, "data.txt"), "payload");
});

afterEach(() => {
  delete process.env.AGNZ_DATA_DIR;
  rmSync(projectCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

// The conversation now comes out of the one log (ADR 0020).
function readTranscript(cwd, id) {
  const f = join(cwd, ".claude", "agnz", "threads", `${id}.log.jsonl`);
  if (!existsSync(f)) return [];
  const entries = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return entries.filter((e) => e.type === "message");
}

// The frozen prefix is stored once, in its own write-once file, and referenced
// from the log by digest — it is no longer copied into an event.
function frozenPrompt(cwd, id) {
  const f = join(cwd, ".claude", "agnz", "threads", `${id}.system.txt`);
  return existsSync(f) ? readFileSync(f, "utf8") : "";
}

test("the agent is told its remaining turns at the budget marks", async () => {
  const threadMgr = createThreadManager();
  // maxTurns 3 → remaining is 3, 2, 1 across turns 0, 1, 2. Only 2 is a mark.
  const thread = await threadMgr.createThread({
    cwd: projectCwd,
    name: "dev",
    agentDef: { name: "dev", tools: ["Read"], maxTurns: 3 },
  });
  const sandbox = createSandbox({ root: projectCwd, policy: { Read: "allow" } });

  await runThread({
    thread,
    threadMgr,
    sandbox,
    registry: createRegistry(),
    profile: { baseUrl: "http://fake", model: "fake", name: "p" },
    userMessage: "read the file",
    chat: fakeChat([
      toolCall("c1", "Read", { path: "data.txt" }),
      toolCall("c2", "Read", { path: "data.txt", start_line: 1, end_line: 1 }),
      finalMessage("done"),
    ]),
  });

  const notices = readTranscript(projectCwd, thread.id)
    .filter((m) => m.role === "user" && String(m.content).includes("Turn budget:"));

  assert.equal(notices.length, 1, "exactly one budget notice (only remaining=2 is a mark)");
  assert.match(notices[0].content, /Turn budget: 2 of 3 turns left/);
  assert.match(notices[0].content, /finish the most valuable part/);
});

test("no budget notice while the agent has plenty of turns left", async () => {
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({
    cwd: projectCwd,
    name: "dev",
    agentDef: { name: "dev", tools: ["Read"], maxTurns: 40 },
  });
  const sandbox = createSandbox({ root: projectCwd, policy: { Read: "allow" } });

  await runThread({
    thread,
    threadMgr,
    sandbox,
    registry: createRegistry(),
    profile: { baseUrl: "http://fake", model: "fake", name: "p" },
    userMessage: "read the file",
    chat: fakeChat([toolCall("c1", "Read", { path: "data.txt" }), finalMessage("done")]),
  });

  const notices = readTranscript(projectCwd, thread.id)
    .filter((m) => m.role === "user" && String(m.content).includes("Turn budget:"));
  assert.equal(notices.length, 0, "a run that ends far from the limit is never warned");
});

test("a thread without an agent def still gets framing and the tool policy note", async () => {
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({ cwd: projectCwd, name: "legacy" });
  const sandbox = createSandbox({ root: projectCwd, policy: { Read: "allow" } });

  await runThread({
    thread,
    threadMgr,
    sandbox,
    registry: createRegistry(),
    // createThread no longer persists a systemPrompt; the profile is the live
    // configuration path for one, so that is what this exercises.
    profile: {
      baseUrl: "http://fake",
      model: "fake",
      name: "p",
      systemPrompt: "You are a systems programmer. Answer in German.",
    },
    userMessage: "hi",
    chat: fakeChat([finalMessage("done")]),
  });

  const prompt = frozenPrompt(projectCwd, thread.id);
  assert.match(prompt, /coding sub-agent running inside a sandbox/, "sandbox framing present");
  assert.match(prompt, /Available tools: .*\bRead\b/, "tool policy note present");
  assert.match(prompt, /Workflow:/, "the workflow rules the harness enforces are stated");
  assert.match(prompt, /You are a systems programmer/, "the custom role is kept, as a layer");
});

test("an agent def body wins the role slot over a configured systemPrompt", async () => {
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({
    cwd: projectCwd,
    name: "dev",
    agentDef: { name: "dev", tools: ["Read"], body: "ROLE FROM AGENT DEF" },
  });
  const sandbox = createSandbox({ root: projectCwd, policy: { Read: "allow" } });

  await runThread({
    thread,
    threadMgr,
    sandbox,
    registry: createRegistry(),
    profile: {
      baseUrl: "http://fake",
      model: "fake",
      name: "p",
      systemPrompt: "ROLE FROM PROFILE",
    },
    userMessage: "hi",
    chat: fakeChat([finalMessage("done")]),
  });

  const prompt = frozenPrompt(projectCwd, thread.id);
  assert.match(prompt, /ROLE FROM AGENT DEF/);
  assert.doesNotMatch(prompt, /ROLE FROM PROFILE/, "the two role sources never both land");
});

test("show reports prompt drift only when the frozen prompt predates this build", async () => {
  const { buildShowView } = await import("../bin/agnz.mjs");
  const running = { version: "0.22.0", promptTemplates: "aaaa1111" };

  const fresh = buildShowView(
    { id: "t1", promptVersion: "0.22.0", promptTemplates: "aaaa1111" },
    running,
  );
  assert.equal(fresh.promptDrift, undefined, "a current thread stays quiet");

  // The case the version alone cannot catch: same version, changed prompt.
  const sameVersion = buildShowView(
    { id: "t2", promptVersion: "0.22.0", promptTemplates: "bbbb2222", agentDef: { name: "dev" } },
    running,
  );
  assert.ok(sameVersion.promptDrift, "same-version template drift is still drift");
  assert.match(sameVersion.promptDrift.action, /agnz start .*--agent dev/);
  assert.match(sameVersion.promptDrift.bornAt, /bbbb2222/);

  const olderVersion = buildShowView(
    { id: "t3", promptVersion: "0.21.0", promptTemplates: "aaaa1111" },
    running,
  );
  assert.ok(olderVersion.promptDrift, "an older version is drift even at an equal digest");

  const legacy = buildShowView({ id: "t4" }, running);
  assert.equal(legacy.promptDrift, undefined, "an unstamped legacy thread cannot be judged");
});
