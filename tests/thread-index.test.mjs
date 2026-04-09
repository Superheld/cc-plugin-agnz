// node:test coverage for lib/thread-index.mjs.
//
// Every test points $AGNZ_DATA_DIR at a fresh temp dir so the index
// file is isolated per test.
//
// Run with: node --test tests/thread-index.test.mjs

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  registerThread,
  lookupThreadCwd,
  forgetThread,
  listIndex,
} from "../lib/thread-index.mjs";

let userDir;

beforeEach(() => {
  userDir = mkdtempSync(join(tmpdir(), "agnz-index-"));
  process.env.AGNZ_DATA_DIR = userDir;
});

afterEach(() => {
  delete process.env.AGNZ_DATA_DIR;
  rmSync(userDir, { recursive: true, force: true });
});

describe("thread-index", () => {
  test("lookup on empty index returns null", async () => {
    const result = await lookupThreadCwd("nonexistent-id");
    assert.equal(result, null);
  });

  test("listIndex on empty returns empty object", async () => {
    const result = await listIndex();
    assert.deepEqual(result, {});
  });

  test("register then lookup resolves the cwd", async () => {
    await registerThread("t-1", "/proj/one");
    const result = await lookupThreadCwd("t-1");
    assert.equal(result, "/proj/one");
  });

  test("register creates the index file on disk", async () => {
    await registerThread("t-2", "/proj/two");
    assert.ok(existsSync(join(userDir, "thread-index.json")));
  });

  test("register absolutises relative cwd paths", async () => {
    await registerThread("t-3", "./relative");
    const result = await lookupThreadCwd("t-3");
    assert.ok(result.endsWith("relative"));
    assert.ok(result.startsWith("/"));
  });

  test("register with existing id overwrites the entry", async () => {
    await registerThread("t-4", "/first");
    await registerThread("t-4", "/second");
    assert.equal(await lookupThreadCwd("t-4"), "/second");
  });

  test("forget removes the entry", async () => {
    await registerThread("t-5", "/proj/five");
    await forgetThread("t-5");
    assert.equal(await lookupThreadCwd("t-5"), null);
  });

  test("forget on unknown id is a no-op (no throw)", async () => {
    await forgetThread("never-registered");
    assert.deepEqual(await listIndex(), {});
  });

  test("listIndex returns all registered threads", async () => {
    await registerThread("t-6", "/a");
    await registerThread("t-7", "/b");
    await registerThread("t-8", "/c");
    const all = await listIndex();
    assert.equal(Object.keys(all).length, 3);
    assert.equal(all["t-6"].cwd, "/a");
    assert.ok(typeof all["t-6"].createdAt === "number");
  });

  test("entries survive across separate register calls", async () => {
    await registerThread("t-9", "/x");
    await registerThread("t-10", "/y");
    assert.equal(await lookupThreadCwd("t-9"), "/x");
    assert.equal(await lookupThreadCwd("t-10"), "/y");
  });
});
