// node:test coverage for the index/disk self-healing in lib/threads.mjs.
//
// The user-wide thread index can desync from the on-disk thread metas
// (e.g. an over-aggressive prune drops an entry whose meta still exists).
// Such a "ghost" — meta on disk, no index entry — used to be invisible to
// `agnz list` and unresolvable by `send <name>`. reconcileWorkspace() and
// the now self-healing listThreads() repair that: the threads/ dir is the
// source of truth and any missing index entry is re-registered.
//
// Each test isolates $AGNZ_DATA_DIR (index) and uses a fresh temp cwd.
//
// Run with: node --test tests/thread-reconcile.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createThreadManager } from "../lib/threads.mjs";
import { forgetThread, lookupThreadCwd } from "../lib/thread-index.mjs";

let userDir;
let cwd;

beforeEach(() => {
  userDir = mkdtempSync(join(tmpdir(), "agnz-reconcile-user-"));
  cwd = mkdtempSync(join(tmpdir(), "agnz-reconcile-cwd-"));
  process.env.AGNZ_DATA_DIR = userDir;
});

afterEach(() => {
  delete process.env.AGNZ_DATA_DIR;
  rmSync(userDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test("reconcileWorkspace recovers a ghost and re-registers it", async () => {
  const tm = createThreadManager();
  const t = await tm.createThread({ cwd, name: "ghost" });

  // Simulate the index losing the entry while the meta stays on disk.
  await forgetThread(t.id);
  assert.equal(await lookupThreadCwd(t.id), null, "precondition: thread is a ghost");

  const threads = await tm.reconcileWorkspace(cwd);
  assert.ok(threads.some((x) => x.id === t.id), "ghost is returned from the dir scan");
  assert.equal(await lookupThreadCwd(t.id), cwd, "ghost was re-registered in the index");

  // By-id resolution (send/show by id) works again after re-registration.
  const got = await tm.getThread(t.id);
  assert.ok(got && got.id === t.id, "getThread resolves the recovered thread by id");
});

test("listThreads self-heals a ghost in an index-known workspace", async () => {
  const tm = createThreadManager();
  const keep = await tm.createThread({ cwd, name: "keep" });
  const ghost = await tm.createThread({ cwd, name: "ghost" });

  // Drop only the ghost from the index. The workspace stays discoverable via
  // `keep`, so the cross-workspace listThreads can still reach the cwd.
  await forgetThread(ghost.id);

  const ids = (await tm.listThreads()).map((t) => t.id);
  assert.ok(ids.includes(keep.id), "indexed thread is listed");
  assert.ok(ids.includes(ghost.id), "ghost is listed via self-heal");
  assert.equal(await lookupThreadCwd(ghost.id), cwd, "ghost was re-registered");
});

test("reconcileWorkspace is a no-op (no duplicates) when nothing is missing", async () => {
  const tm = createThreadManager();
  await tm.createThread({ cwd, name: "a" });
  await tm.createThread({ cwd, name: "b" });

  const first = await tm.reconcileWorkspace(cwd);
  const second = await tm.reconcileWorkspace(cwd);
  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  assert.deepEqual(
    second.map((t) => t.id).sort(),
    first.map((t) => t.id).sort(),
  );
});
