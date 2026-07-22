import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the user-wide data dir BEFORE importing the thread layer so the
// thread index never touches the real ~/.claude/agnz.
process.env.AGNZ_DATA_DIR = mkdtempSync(join(tmpdir(), "agnz-user-"));
const { createThreadManager } = await import("../lib/threads.mjs");

test("concurrent updateThread (object patches) loses no update", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "agnz-proj-"));
  const tm = createThreadManager();
  const t = await tm.createThread({ cwd, name: "c" });
  const N = 20;
  await Promise.all(Array.from({ length: N }, (_, i) => tm.updateThread(t.id, { ["k" + i]: i })));
  const after = await tm.getThread(t.id);
  for (let i = 0; i < N; i++) assert.equal(after["k" + i], i);
});

test("functional-patch appends are not lost under concurrency", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "agnz-proj-"));
  const tm = createThreadManager();
  const t = await tm.createThread({ cwd, name: "c2" });
  const N = 20;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      tm.updateThread(t.id, (cur) => {
        const sc = cur.sessionCommands || { sessionAllow: [], sessionDeny: [] };
        return { sessionCommands: { ...sc, sessionAllow: [...sc.sessionAllow, "c" + i] } };
      }),
    ),
  );
  const after = await tm.getThread(t.id);
  assert.equal(after.sessionCommands.sessionAllow.length, N);
});

// ── claimThread: runner admission control (finding A, two-runner race) ────────

test("claimThread clears the CLI's pendingRun spawn marker in the same atomic write", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "agnz-proj-"));
  const tm = createThreadManager();
  const t = await tm.createThread({ cwd, name: "spawnmark" });
  // The CLI stamps this before spawning the runner (send→wait race fix).
  await tm.updateThread(t.id, { pendingRun: { spawnedAt: Date.now() } });
  const ok = await tm.claimThread(t.id, 42, { isAlive: () => true });
  assert.equal(ok, true);
  const after = await tm.getThread(t.id);
  assert.equal(after.pendingRun, null);
  assert.equal(after.status, "running");
});

test("claimThread refuses when a different live runner owns a running thread", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "agnz-proj-"));
  const tm = createThreadManager();
  const t = await tm.createThread({ cwd, name: "claim1" });
  await tm.setStatus(t.id, "running", { runnerPid: 4242 });
  const before = await tm.getThread(t.id);
  const ok = await tm.claimThread(t.id, 9999, { isAlive: () => true });
  assert.equal(ok, false, "a second runner must lose the race");
  const after = await tm.getThread(t.id);
  assert.equal(after.runnerPid, 4242, "the owner's runnerPid must not be clobbered");
  assert.equal(after.status, "running");
  // SKIP_MUTATION means truly no write — not even an updatedAt bump.
  assert.equal(after.updatedAt, before.updatedAt, "refused claim must write nothing");
});

test("claimThread succeeds over a dead runner pid (stale claim is reclaimable)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "agnz-proj-"));
  const tm = createThreadManager();
  const t = await tm.createThread({ cwd, name: "claim2" });
  await tm.setStatus(t.id, "running", { runnerPid: 999999 });
  const ok = await tm.claimThread(t.id, 7, { isAlive: () => false });
  assert.equal(ok, true, "a stale (dead-owner) running thread stays claimable");
  const after = await tm.getThread(t.id);
  assert.equal(after.runnerPid, 7);
  assert.equal(after.status, "running");
});

test("claimThread succeeds on an idle thread and records the runner pid + running", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "agnz-proj-"));
  const tm = createThreadManager();
  const t = await tm.createThread({ cwd, name: "claim3" }); // created idle
  const ok = await tm.claimThread(t.id, 55, { isAlive: () => true });
  assert.equal(ok, true);
  const after = await tm.getThread(t.id);
  assert.equal(after.runnerPid, 55);
  assert.equal(after.status, "running");
});

test("claimThread clears stale pending/error when claiming (invariant matches setStatus RUNNING)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "agnz-proj-"));
  const tm = createThreadManager();
  const t = await tm.createThread({ cwd, name: "claim4" });
  await tm.setStatus(t.id, "awaiting_input", {
    pending: { toolCallId: "x", kind: "approval" },
    error: { message: "stale" },
  });
  const ok = await tm.claimThread(t.id, 12, { isAlive: () => true });
  assert.equal(ok, true);
  const after = await tm.getThread(t.id);
  assert.equal(after.pending, null);
  assert.equal(after.error, null);
});
