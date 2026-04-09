#!/usr/bin/env node
// Two-agent dogfood for ADR 0002 (communication: mailboxes and events).
//
// Wires the library modules directly — no MCP, no plugin cache — and
// runs three scripted steps against whatever profile is currently
// active in your local agnz setup:
//
//   1. alice sends bob a question via send_message
//   2. bob drains his inbox (automatic at top of turn), computes an
//      answer, and replies via send_message
//   3. alice wakes up, drains her own inbox, and reports what bob said
//
// Exercises messages-log + event-bus + loop mailbox drain + the
// send_message tool end-to-end. Useful as a reference for how the
// cross-agent communication primitives are supposed to interlock and
// as a smoke test for changes in that area.
//
// Requires: an active profile (run /agnz:setup first).
// Run from the repo root:
//   node docs/examples/dogfood-two-agents.mjs

import { rm, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { createThreadManager } from "../../lib/threads.mjs";
import { createSandbox, defaultPolicy } from "../../lib/sandbox.mjs";
import { createRegistry } from "../../lib/tools/registry.mjs";
import { runThread } from "../../lib/loop.mjs";
import { createProfileStore } from "../../lib/profiles.mjs";
import { readAllMessages } from "../../lib/messages-log.mjs";
import { resolveUserDir } from "../../lib/data-dir.mjs";

const TEST_CWD = "/tmp/agnz-dogfood";

const ALICE_PROMPT = `You are "alice", an agent in a team. Your partner is named "bob".

Communication rules:
- Send messages to other agents or the parent with the send_message tool.
- Reading is automatic: new mail arrives as a synthetic user message at the top of each turn. There is NO read tool.
- Do not poll. Send, then finish. The orchestrator will wake you again when there is news.

YOUR TASK RIGHT NOW:
Send bob a question asking him "What is 7 + 15?". Use send_message with to="bob", kind="question", text="What is 7 + 15?". Then give a one-line status ("question sent to bob") and stop. Do not try to wait for the reply — just stop.`;

const BOB_PROMPT = `You are "bob", an agent in a team. Your partner is named "alice".

Communication rules:
- Send messages to other agents or the parent with the send_message tool.
- Reading is automatic: new mail arrives as a synthetic user message at the top of each turn.

YOUR TASK:
Check your inbox. If you see a question from alice, compute the answer and reply via send_message with to="alice", kind="answer", ref=<the question message id, e.g. m000001>, text=<your answer>. Then give a one-line status and stop.`;

const ALICE_FOLLOWUP_PROMPT = `You are "alice". Bob may have answered your question by now. Check your inbox for his reply, then give a one-line factual report of what happened ("bob said X") and stop.`;

function header(s) {
  const line = "=".repeat(72);
  console.log("\n" + line + "\n" + s + "\n" + line);
}

function dumpLog(messages) {
  for (const m of messages) {
    const to = Array.isArray(m.to) ? m.to.join(",") : m.to;
    const ref = m.ref ? ` (re: ${m.ref})` : "";
    console.log(`  ${m.id} ${m.from} → ${to} ${m.kind}${ref}: ${m.text}`);
  }
  if (messages.length === 0) console.log("  (empty)");
}

async function main() {
  // Clean slate
  await rm(TEST_CWD, { recursive: true, force: true });
  await mkdir(TEST_CWD, { recursive: true });

  // Load the active profile (uses resolveUserDir which respects AGNZ_DATA_DIR)
  const profileStore = createProfileStore({ dataDir: resolveUserDir() });
  const profile = await profileStore.get();
  if (!profile) {
    throw new Error("no active profile — run /agnz:setup first");
  }
  console.log(`profile: ${profile.name} (${profile.model} @ ${profile.baseUrl})`);

  const threadMgr = createThreadManager();
  const registry = createRegistry();
  const sandbox = createSandbox({ root: TEST_CWD, policy: defaultPolicy() });

  // Create both threads with custom system prompts.
  const aliceMeta = await threadMgr.createThread({
    cwd: TEST_CWD,
    profile: profile.name,
    policy: defaultPolicy(),
    systemPrompt: ALICE_PROMPT,
  });
  await threadMgr.updateThread(aliceMeta.id, { agentName: "alice" });

  const bobMeta = await threadMgr.createThread({
    cwd: TEST_CWD,
    profile: profile.name,
    policy: defaultPolicy(),
    systemPrompt: BOB_PROMPT,
  });
  await threadMgr.updateThread(bobMeta.id, { agentName: "bob" });

  console.log(`alice thread: ${aliceMeta.id}`);
  console.log(`bob   thread: ${bobMeta.id}`);

  // -------- STEP 1: alice kicks off --------
  header("STEP 1: alice sends the question");
  const alice1 = await runThread({
    thread: await threadMgr.getThread(aliceMeta.id),
    threadMgr,
    sandbox,
    registry,
    profile,
    userMessage: "Begin your task now.",
  });
  console.log(`alice status: ${alice1.status}`);
  console.log(`alice content:`, alice1.content);
  console.log("\nmessages.jsonl after step 1:");
  dumpLog(await readAllMessages(TEST_CWD));

  // -------- STEP 2: bob drains and replies --------
  header("STEP 2: bob drains his inbox and replies");
  const bob1 = await runThread({
    thread: await threadMgr.getThread(bobMeta.id),
    threadMgr,
    sandbox,
    registry,
    profile,
    userMessage: "Check your inbox and act on any messages you find.",
  });
  console.log(`bob status: ${bob1.status}`);
  console.log(`bob content:`, bob1.content);
  console.log("\nmessages.jsonl after step 2:");
  dumpLog(await readAllMessages(TEST_CWD));

  // -------- STEP 3: alice wakes up and reports --------
  header("STEP 3: alice wakes up and reports bob's answer");
  const aliceMetaNow = await threadMgr.getThread(aliceMeta.id);
  // Swap in the follow-up system prompt
  await threadMgr.updateThread(aliceMeta.id, { systemPrompt: ALICE_FOLLOWUP_PROMPT });
  const alice2 = await runThread({
    thread: await threadMgr.getThread(aliceMeta.id),
    threadMgr,
    sandbox,
    registry,
    profile,
    userMessage: "Check your inbox and report.",
  });
  console.log(`alice status: ${alice2.status}`);
  console.log(`alice content:`, alice2.content);

  header("FINAL STATE");
  console.log("messages.jsonl:");
  dumpLog(await readAllMessages(TEST_CWD));

  const aliceFinal = await threadMgr.getThread(aliceMeta.id);
  const bobFinal = await threadMgr.getThread(bobMeta.id);
  console.log(`\nalice inboxCursor: ${aliceFinal.inboxCursor || "(null)"}`);
  console.log(`bob   inboxCursor: ${bobFinal.inboxCursor || "(null)"}`);
  console.log(`alice final status: ${aliceFinal.status}`);
  console.log(`bob   final status: ${bobFinal.status}`);
}

main().catch((err) => {
  console.error("dogfood failed:", err);
  process.exit(1);
});
