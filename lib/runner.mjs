#!/usr/bin/env node
// Detached run process (ADR redesign, model "c"). The CLI spawns this,
// unref'd, for every start/send/approve/answer that needs the loop to move
// forward; it runs runThread one segment (until the next pause or finish),
// then exits. State lives in files; results reach the parent via the existing
// SendMessage → messages.jsonl → UserPromptSubmit-hook path (unchanged).
//
// The payload (threadId + userMessage|resumeInput) is handed over via a temp
// JSON file whose path is argv[2]; the runner consumes and deletes it.
//
// Signals: SIGTERM aborts the in-flight run cleanly (this is how `agnz stop`
// reaches a detached runner). The runner records its pid on the thread meta so
// the CLI can find it.

import { readFileSync, unlinkSync } from "node:fs";
import { createThreadManager } from "./threads.mjs";
import { createRegistry } from "./tools/registry.mjs";
import { runThread } from "./loop.mjs";
import { resolveProfile, makeSandbox, PLUGIN_ROOT } from "./orchestrate.mjs";

const payloadPath = process.argv[2];
if (!payloadPath) {
  process.stderr.write("runner: payload path required\n");
  process.exit(2);
}

let payload;
try {
  payload = JSON.parse(readFileSync(payloadPath, "utf8"));
} catch (err) {
  process.stderr.write(`runner: bad payload: ${err.message}\n`);
  process.exit(2);
}
try {
  unlinkSync(payloadPath);
} catch {
  /* best-effort cleanup */
}

const { threadId, userMessage = null, resumeInput = null } = payload;
const threadMgr = createThreadManager();
const registry = createRegistry();

const thread = await threadMgr.getThread(threadId);
if (!thread) {
  process.stderr.write(`runner: no such thread ${threadId}\n`);
  process.exit(1);
}

const profile = await resolveProfile(thread);
if (!profile) {
  await threadMgr.setStatus(threadId, "error", {
    error: { message: "no LLM profile configured for this thread (run /agnz:setup add)" },
    pending: null,
  });
  process.exit(1);
}

const sandbox = makeSandbox(thread, registry);

const controller = new AbortController();
let interrupted = false;
// SIGTERM = stop (terminal; `agnz stop` also marks the thread stopped).
// SIGUSR1 = hard interrupt: abort the current segment but leave the thread
// resumable. Any directive sent alongside the interrupt is already queued in
// the mailbox and drains on the next run.
process.on("SIGTERM", () => controller.abort());
process.on("SIGUSR1", () => {
  interrupted = true;
  controller.abort();
});

await threadMgr.updateThread(threadId, { runnerPid: process.pid });

try {
  await runThread({
    thread,
    threadMgr,
    sandbox,
    registry,
    profile,
    pluginRoot: PLUGIN_ROOT,
    userMessage,
    resumeInput,
    signal: controller.signal,
  });
} catch {
  // runThread already recorded an error status and published to the parent;
  // nothing more to do here.
} finally {
  const patch = { runnerPid: null };
  // On interrupt, abort left the thread mid-run — reset it to idle/resumable.
  if (interrupted) {
    patch.status = "idle";
    patch.pending = null;
  }
  await threadMgr.updateThread(threadId, patch).catch(() => {});
}

process.exit(0);
