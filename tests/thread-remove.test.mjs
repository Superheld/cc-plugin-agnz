// node:test coverage for permanent thread deletion (removeThread) and the
// prefix-based file sweep behind it. `stop` archives; `remove` disposes —
// these tests pin that split and the guarantee that no companion file is
// left behind as an unknown orphan.
//
// Run with: node --test tests/thread-remove.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createThreadManager } from "../lib/threads.mjs";

let projectCwd;
let userDir;

beforeEach(() => {
  projectCwd = mkdtempSync(join(tmpdir(), "agnz-remove-cwd-"));
  userDir = mkdtempSync(join(tmpdir(), "agnz-remove-user-"));
  process.env.AGNZ_DATA_DIR = userDir;
});

afterEach(() => {
  delete process.env.AGNZ_DATA_DIR;
  rmSync(projectCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test("removeThread deletes every <id>.* file and the index entry", async () => {
  const tm = createThreadManager();
  const thread = await tm.createThread({ cwd: projectCwd, name: "victim", agentDef: { name: "dev" } });
  await tm.appendMessage(thread.id, { role: "user", content: "hi" });

  const threadsDir = join(projectCwd, ".claude", "agnz", "threads");
  // A companion file the code does not know by name — must be swept too.
  writeFileSync(join(threadsDir, `${thread.id}.future-companion.bin`), "x");

  assert.ok(await tm.getThread(thread.id), "resolvable before removal");

  const { files } = await tm.removeThread(thread.id);
  assert.ok(files.length >= 3, `meta + transcript + companion swept, got: ${files}`);

  const leftovers = readdirSync(threadsDir).filter((n) => n.startsWith(thread.id));
  assert.deepEqual(leftovers, [], "no per-thread file survives");
  assert.equal(await tm.getThread(thread.id), null, "no longer resolvable");
});

test("removeThread leaves other threads' files untouched", async () => {
  const tm = createThreadManager();
  const a = await tm.createThread({ cwd: projectCwd, name: "a", agentDef: { name: "dev" } });
  const b = await tm.createThread({ cwd: projectCwd, name: "b", agentDef: { name: "dev" } });

  await tm.removeThread(a.id);

  const threadsDir = join(projectCwd, ".claude", "agnz", "threads");
  assert.ok(existsSync(join(threadsDir, `${b.id}.meta.json`)), "sibling meta survives");
  assert.ok(await tm.getThread(b.id));
});

test("removeThread on an unknown id throws", async () => {
  const tm = createThreadManager();
  await assert.rejects(tm.removeThread("no-such-id"), /no such thread/);
});
