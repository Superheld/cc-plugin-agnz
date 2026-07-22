// node:test coverage for lib/data-dir.mjs.
//
// Uses the built-in node:test runner. No deps, no config. Run with:
//   node --test tests/data-dir.test.mjs
// or the whole suite:
//   node --test tests/

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveUserDir, resolveProjectDir } from "../lib/data-dir.mjs";

describe("resolveUserDir", () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = process.env.AGNZ_DATA_DIR;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.AGNZ_DATA_DIR;
    else process.env.AGNZ_DATA_DIR = savedEnv;
  });

  test("honors $AGNZ_DATA_DIR when set", () => {
    const dir = mkdtempSync(join(tmpdir(), "agnz-user-"));
    try {
      process.env.AGNZ_DATA_DIR = dir;
      assert.equal(resolveUserDir(), resolve(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  test("absolutises relative AGNZ_DATA_DIR", () => {
    process.env.AGNZ_DATA_DIR = "./relative-path";
    const result = resolveUserDir();
    assert.equal(result, resolve("./relative-path"));
  });

  test("returns a non-empty path without env override", () => {
    delete process.env.AGNZ_DATA_DIR;
    const result = resolveUserDir();
    assert.ok(typeof result === "string" && result.length > 0);
    assert.ok(result.endsWith("agnz") || result.includes("agnz"));
  });
});

describe("resolveProjectDir", () => {
  test("appends .claude/agnz to the given cwd", () => {
    const result = resolveProjectDir("/some/project");
    assert.equal(result, resolve("/some/project/.claude/agnz"));
  });

  test("absolutises relative cwd", () => {
    const result = resolveProjectDir("./foo");
    assert.equal(result, resolve("./foo/.claude/agnz"));
  });

  test("throws on missing cwd", () => {
    assert.throws(() => resolveProjectDir(""), /cwd is required/);
    assert.throws(() => resolveProjectDir(undefined), /cwd is required/);
  });
});

