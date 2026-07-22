// Direct unit tests for the simple filesystem tools: LS, Read, Write.
// These ran only indirectly through loop tests before — here we pin their
// edge behaviour (caps, slices, clobber guard, error shapes) head-on.
//
// Run with: node --test tests/fs-tools.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSandbox } from "../lib/sandbox.mjs";
import LS from "../lib/tools/LS.mjs";
import Read from "../lib/tools/Read.mjs";
import Write from "../lib/tools/Write.mjs";

let root;
let ctx;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agnz-fstools-"));
  ctx = { sandbox: createSandbox({ root, policy: {} }) };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

// ---------- LS ----------

test("LS lists files with sizes and dirs with a marker", async () => {
  writeFileSync(join(root, "a.txt"), "12345");
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "b.txt"), "x");
  const r = await LS.run({ path: "." }, ctx);
  assert.notEqual(r.isError, true);
  assert.match(r.content, /^Contents of \. \(2 entries\):/);
  assert.match(r.content, /f a\.txt 5/);
  assert.match(r.content, /d sub/);
  assert.ok(!r.content.includes("b.txt"), "depth 1 must not descend");
});

test("LS depth recurses and marks skip-dirs without descending", async () => {
  mkdirSync(join(root, "sub", "deep"), { recursive: true });
  writeFileSync(join(root, "sub", "deep", "c.txt"), "x");
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), "x");
  const r = await LS.run({ path: ".", depth: 3 }, ctx);
  assert.match(r.content, /f sub\/deep\/c\.txt 1/);
  assert.match(r.content, /d node_modules \(skipped\)/);
  assert.ok(!r.content.includes("index.js"));
});

test("LS marks symlinks with l", async () => {
  writeFileSync(join(root, "target.txt"), "x");
  symlinkSync(join(root, "target.txt"), join(root, "link"));
  const r = await LS.run({ path: "." }, ctx);
  assert.match(r.content, /l link/);
});

test("LS errors on missing path and on files", async () => {
  const missing = await LS.run({ path: "nope" }, ctx);
  assert.equal(missing.isError, true);
  assert.match(missing.content, /does not exist/);
  writeFileSync(join(root, "f.txt"), "x");
  const notDir = await LS.run({ path: "f.txt" }, ctx);
  assert.equal(notDir.isError, true);
  assert.match(notDir.content, /not a directory/);
});

// ---------- Read ----------

test("Read returns 1-based numbered lines with a header", async () => {
  writeFileSync(join(root, "f.txt"), "alpha\nbeta\ngamma\n");
  const r = await Read.run({ path: "f.txt" }, ctx);
  assert.notEqual(r.isError, true);
  assert.match(r.content, /^# f\.txt \(lines 1-4 of 4\)/);
  assert.match(r.content, /    1  alpha/);
  assert.match(r.content, /    3  gamma/);
});

test("Read slices with start_line/end_line (inclusive)", async () => {
  writeFileSync(join(root, "f.txt"), "l1\nl2\nl3\nl4\nl5\n");
  const r = await Read.run({ path: "f.txt", start_line: 2, end_line: 4 }, ctx);
  assert.match(r.content, /\(lines 2-4 of 6\)/);
  assert.ok(r.content.includes("l2") && r.content.includes("l4"));
  assert.ok(!r.content.includes("l1") && !r.content.includes("l5"));
});

test("Read refuses files over the 512 KiB cap with a slice hint", async () => {
  writeFileSync(join(root, "big.txt"), "x".repeat(600 * 1024));
  const r = await Read.run({ path: "big.txt" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content, /file too large .*start_line\/end_line/);
});

test("Read errors on missing files and directories", async () => {
  const missing = await Read.run({ path: "nope.txt" }, ctx);
  assert.equal(missing.isError, true);
  assert.match(missing.content, /does not exist/);
  mkdirSync(join(root, "d"));
  const dir = await Read.run({ path: "d" }, ctx);
  assert.equal(dir.isError, true);
  assert.match(dir.content, /not a regular file/);
});

// ---------- Write ----------

test("Write creates a new file, parent dirs included", async () => {
  const r = await Write.run({ path: "new/deep/f.txt", content: "hello" }, ctx);
  assert.notEqual(r.isError, true);
  assert.match(r.content, /Wrote new\/deep\/f\.txt \(5 bytes\)\./);
  assert.equal(readFileSync(join(root, "new", "deep", "f.txt"), "utf8"), "hello");
});

test("Write refuses to clobber without overwrite=true", async () => {
  writeFileSync(join(root, "f.txt"), "original");
  const refused = await Write.run({ path: "f.txt", content: "clobber" }, ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.content, /already exists.*overwrite=true/);
  assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "original");

  const forced = await Write.run({ path: "f.txt", content: "clobber", overwrite: true }, ctx);
  assert.match(forced.content, /Overwrote f\.txt/);
  assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "clobber");
});

test("Write refuses when the path exists as a directory", async () => {
  mkdirSync(join(root, "d"));
  const r = await Write.run({ path: "d", content: "x", overwrite: true }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content, /not a regular file/);
});

test("Write enforces the 1 MiB content cap and the string type", async () => {
  const tooBig = await Write.run({ path: "f.txt", content: "x".repeat(1024 * 1024 + 1) }, ctx);
  assert.equal(tooBig.isError, true);
  assert.match(tooBig.content, /content too large/);
  assert.ok(!existsSync(join(root, "f.txt")));

  const notString = await Write.run({ path: "f.txt", content: 42 }, ctx);
  assert.equal(notString.isError, true);
  assert.match(notString.content, /content must be a string/);
});
