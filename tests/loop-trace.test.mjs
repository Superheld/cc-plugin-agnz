// node:test coverage for the ADR 0011 runtime trace schema.
//
// Drives the real agent loop with an injected fake LLM (ctx.chat) so the
// test is fully deterministic and needs no running model. Asserts that a
// complete run emits the expected trace events: thread_start, one llm_call
// per turn (with normalized usage), a tool_call with an outcome, and a
// single thread_end carrying the terminal reason and per-run totals.
//
// This doubles as the bootstrap for the fake-LLM harness the rest of the
// loop/sandbox/mailbox tests (ADR 0011 §4) will build on.
//
// Run with: node --test tests/loop-trace.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createThreadManager } from "../lib/threads.mjs";
import { createSandbox } from "../lib/sandbox.mjs";
import { createRegistry } from "../lib/tools/registry.mjs";
import { runThread } from "../lib/loop.mjs";

let projectCwd;
let userDir;

beforeEach(() => {
  projectCwd = mkdtempSync(join(tmpdir(), "agnz-trace-cwd-"));
  userDir = mkdtempSync(join(tmpdir(), "agnz-trace-user-"));
  // Thread index lives under the user dir; keep it off the real ~/.claude.
  process.env.AGNZ_DATA_DIR = userDir;
  // A file for the read-only tool to find.
  writeFileSync(join(projectCwd, "hello.txt"), "hi from the sandbox\n");
});

afterEach(() => {
  delete process.env.AGNZ_DATA_DIR;
  rmSync(projectCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** Read and parse the thread's unified log into an array of entries. */
function readTrace(cwd, threadId) {
  const file = join(cwd, ".claude", "agnz", "threads", `${threadId}.log.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/**
 * Tracing is deliberately fire-and-forget in the loop (it must never block
 * or crash the run), so the final thread_end write may still be in flight
 * when runThread resolves. Poll the trace file until it appears.
 *
 * The deadline is deliberately generous: this is the suite's only bounded
 * wait on fire-and-forget disk I/O, which made it the prime suspect for the
 * rare post-git-merge flake (see docs/next.md → Watch). Polling exits as
 * soon as the predicate matches, so a large ceiling costs nothing when green.
 */
async function waitForLog(cwd, threadId, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const trace = readTrace(cwd, threadId);
    if (predicate(trace)) return trace;
    if (Date.now() > deadline) return trace;
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Build a fake LLM that replays a scripted list of responses, one per call.
 * Each script entry is { message, finishReason?, usage? }.
 */
function fakeChat(script) {
  let i = 0;
  return async () => {
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    return {
      message: step.message,
      finishReason: step.finishReason ?? "stop",
      usage: step.usage ?? null,
      raw: {},
    };
  };
}

test("a complete run emits thread_start, llm_call, tool_call, thread_end", async () => {
  const threadMgr = createThreadManager();
  // agentDef.name is the routing handle the trace records as `agent`.
  const thread = await threadMgr.createThread({
    cwd: projectCwd,
    name: "tracer",
    agentDef: { name: "tracer" },
  });

  // LS is allow-listed in the sandbox so the tool actually runs. Permission
  // decisions read the sandbox policy, not the agentDef.
  const sandbox = createSandbox({ root: projectCwd, policy: { LS: "allow" } });
  const registry = createRegistry();
  const profile = { baseUrl: "http://fake", model: "fake-model", name: "fake-profile" };

  const chat = fakeChat([
    // Turn 0: call a read-only tool.
    {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "LS", arguments: JSON.stringify({ path: "." }) } },
        ],
      },
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    },
    // Turn 1: final answer, no tool calls.
    {
      message: { role: "assistant", content: "Done." },
      usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 },
    },
  ]);

  const outcome = await runThread({
    thread,
    threadMgr,
    sandbox,
    registry,
    profile,
    chat,
    userMessage: "List the sandbox root.",
  });

  assert.equal(outcome.status, "final");

  const trace = await waitForLog(projectCwd, thread.id, (t) => t.some((e) => e.type === "run_end"));
  const byType = (t) => trace.filter((e) => e.type === t);

  // Exactly one run_start, carrying how the run was wired up. It does NOT
  // carry the system prompt: that lives once in <id>.system.txt and is
  // referenced by digest from every request (ADR 0020 §3).
  const starts = byType("run_start");
  assert.equal(starts.length, 1, "exactly one run_start");
  assert.equal(starts[0].model, "fake-model");
  assert.equal(starts[0].agentDef, "tracer");
  assert.equal(starts[0].profile, "fake-profile");
  assert.ok(Array.isArray(starts[0].tools) && starts[0].tools.length > 0);
  assert.doesNotMatch(JSON.stringify(starts[0]), /coding sub-agent/, "no prompt copy");

  // One request/response pair per turn, with latency and normalized usage.
  const requests = byType("api_request");
  assert.equal(requests.length, 2, "two api_request events");
  const llmCalls = byType("api_response");
  assert.equal(llmCalls.length, 2, "two api_response events");
  for (const c of llmCalls) {
    assert.equal(typeof c.latencyMs, "number");
    assert.equal(c.finishReason, "stop");
  }
  assert.deepEqual(llmCalls[0].usage, { prompt: 10, completion: 4, total: 14 });

  // The tool ran and was recorded ok with a latency.
  const toolCalls = byType("tool_exec");
  assert.equal(toolCalls.length, 1, "one tool_exec event");
  assert.equal(toolCalls[0].name, "LS");
  assert.equal(toolCalls[0].outcome, "ok");
  assert.equal(typeof toolCalls[0].latencyMs, "number");
  // `target` carries the path-ish argument — the raw material for the
  // last-activity display on running threads.
  assert.equal(toolCalls[0].target, ".");

  // Exactly one thread_end with the final reason and accumulated totals.
  const ends = byType("run_end");
  assert.equal(ends.length, 1, "exactly one run_end");
  assert.equal(ends[0].reason, "final");
  assert.equal(ends[0].totals.llmCalls, 2);
  assert.equal(ends[0].totals.toolCalls, 1);
  assert.equal(ends[0].totals.totalTokens, 40); // 14 + 26
});

test("a thread that hits max_turns emits a max_turns thread_end", async () => {
  const threadMgr = createThreadManager();
  // maxTurns lives on the agentDef; keep it tiny so the loop bottoms out fast.
  const thread = await threadMgr.createThread({
    cwd: projectCwd,
    name: "looper",
    agentDef: { name: "looper", maxTurns: 2 },
  });
  const sandbox = createSandbox({ root: projectCwd, policy: { LS: "allow" } });
  const registry = createRegistry();
  const profile = { baseUrl: "http://fake", model: "fake-model", name: "fake-profile" };

  // Every turn calls a tool and never produces a final answer → max_turns.
  const chat = fakeChat([
    {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_x", type: "function", function: { name: "LS", arguments: JSON.stringify({ path: "." }) } },
        ],
      },
    },
  ]);

  const outcome = await runThread({
    thread, threadMgr, sandbox, registry, profile, chat,
    userMessage: "Loop forever.",
  });

  assert.equal(outcome.status, "max_turns");
  const trace = await waitForLog(projectCwd, thread.id, (t) => t.some((e) => e.type === "run_end"));
  const ends = trace.filter((e) => e.type === "run_end");
  assert.equal(ends.length, 1);
  assert.equal(ends[0].reason, "max_turns");
});

// --- diagnosing a run that never reached the model --------------------------

test("thread_start records the endpoint and how the run was wired up", async () => {
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({
    cwd: projectCwd,
    name: "dev",
    agentDef: { name: "dev", tools: ["Read"] },
  });
  const sandbox = createSandbox({ root: projectCwd, policy: { Read: "allow" } });

  await runThread({
    thread,
    threadMgr,
    sandbox,
    registry: createRegistry(),
    profile: {
      baseUrl: "http://192.168.0.9:11434/v1",
      apiKey: "secret-value",
      model: "fake",
      name: "lanbox",
      origin: "user",
    },
    userMessage: "hi",
    chat: fakeChat([{ message: { role: "assistant", content: "done" } }]),
  });

  const trace = await waitForLog(projectCwd, thread.id, (t) =>
    t.some((e) => e.type === "run_start"));
  const start = trace.find((e) => e.type === "run_start");
  assert.equal(start.endpoint, "http://192.168.0.9:11434/v1");
  assert.equal(start.profile, "lanbox");
  assert.equal(start.profileOrigin, "user");
  assert.equal(start.agentDef, "dev");
  assert.equal(start.cwd, projectCwd);
  assert.doesNotMatch(JSON.stringify(start), /secret-value/, "the api key never reaches the trace");
});

test("a failed LLM call is traced as llm_call outcome=error, not as a gap", async () => {
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({
    cwd: projectCwd,
    name: "dev",
    agentDef: { name: "dev", tools: ["Read"] },
  });
  const sandbox = createSandbox({ root: projectCwd, policy: { Read: "allow" } });

  // What an unreachable LAN box actually throws, detail and all.
  const unreachable = async () => {
    const err = new Error("llm: request to http://192.168.0.9:11434/v1 failed: connect EHOSTUNREACH");
    err.detail = { kind: "network", url: "http://192.168.0.9:11434/v1", code: "EHOSTUNREACH" };
    throw err;
  };

  await assert.rejects(
    runThread({
      thread,
      threadMgr,
      sandbox,
      registry: createRegistry(),
      profile: { baseUrl: "http://192.168.0.9:11434/v1", model: "fake", name: "lanbox" },
      userMessage: "hi",
      chat: unreachable,
    }),
    /EHOSTUNREACH/,
  );

  const trace = await waitForLog(projectCwd, thread.id, (t) =>
    t.some((e) => e.type === "run_end"));
  const calls = trace.filter((e) => e.type === "api_error");
  assert.equal(calls.length, 1, "the failed call is on the timeline, not missing from it");
  assert.equal(calls[0].endpoint, "http://192.168.0.9:11434/v1");
  assert.equal(calls[0].detail.code, "EHOSTUNREACH");
  assert.ok(typeof calls[0].latencyMs === "number", "how long it tried before failing");
  // ...and the request that went unanswered is still there, so the pair reads
  // as "asked, never answered" instead of as a gap.
  assert.equal(trace.filter((e) => e.type === "api_request").length, 1);
});
