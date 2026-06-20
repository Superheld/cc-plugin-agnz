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
