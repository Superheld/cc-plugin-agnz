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

test("a fresh manager resolves by id after reconcileWorkspace seeds it", async () => {
  // ADR 0017: id → cwd resolution is in-process only. A manager in a fresh
  // process (CLI, runner) knows nothing until it scans the workspace.
  const creator = createThreadManager();
  const t = await creator.createThread({ cwd, name: "ghost" });

  const fresh = createThreadManager();
  assert.equal(await fresh.getThread(t.id), null, "precondition: unseeded manager cannot resolve");

  const threads = await fresh.reconcileWorkspace(cwd);
  assert.ok(threads.some((x) => x.id === t.id), "thread is returned from the dir scan");

  const got = await fresh.getThread(t.id);
  assert.ok(got && got.id === t.id, "getThread resolves after the scan seeded the map");
});

test("getThread resolves with an explicit cwd hint (the runner's path)", async () => {
  const creator = createThreadManager();
  const t = await creator.createThread({ cwd, name: "runner-target" });

  const fresh = createThreadManager();
  const got = await fresh.getThread(t.id, cwd);
  assert.ok(got && got.id === t.id, "cwd hint seeds resolution without a full scan");
  assert.equal(got.cwd, cwd);
});

test("listThreads(cwd) lists every on-disk thread of the workspace", async () => {
  const tm = createThreadManager();
  const a = await tm.createThread({ cwd, name: "keep" });
  const b = await tm.createThread({ cwd, name: "ghost" });

  const ids = (await createThreadManager().listThreads(cwd)).map((t) => t.id);
  assert.ok(ids.includes(a.id) && ids.includes(b.id));
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
