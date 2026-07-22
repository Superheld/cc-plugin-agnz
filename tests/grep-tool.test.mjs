// Direct unit tests for lib/tools/Grep.mjs — the largest tool module.
// Pins the search semantics (regex/literal/case), the include-glob filter,
// the skip rules (vendor dirs, binary sniff, oversize files) and the
// result caps that keep the LLM context bounded.
//
// Run with: node --test tests/grep-tool.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSandbox } from "../lib/sandbox.mjs";
import Grep from "../lib/tools/Grep.mjs";

let root;
let ctx;

function file(rel, content) {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agnz-grep-"));
  ctx = { sandbox: createSandbox({ root, policy: {} }) };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("regex match returns path:line: content lines with a count header", async () => {
  file("a.txt", "nothing\nneedle here\nnothing\n");
  file("sub/b.txt", "needle again\n");
  const r = await Grep.run({ pattern: "needle" }, ctx);
  assert.notEqual(r.isError, true);
  assert.match(r.content, /Found 2 matches in 2 files\./);
  assert.match(r.content, /a\.txt:2: needle here/);
  assert.match(r.content, /sub\/b\.txt:1: needle again/);
});

test("regex is the default: metacharacters are live", async () => {
  file("a.txt", "color\ncolour\n");
  const r = await Grep.run({ pattern: "colou?r" }, ctx);
  assert.match(r.content, /Found 2 matches/);
});

test("literal=true escapes metacharacters", async () => {
  file("a.txt", "price is $5.00 (net)\nprice is $5X00 Xnet)\n");
  const r = await Grep.run({ pattern: "$5.00 (net)", literal: true }, ctx);
  assert.match(r.content, /Found 1 match in 1 file\./);
  assert.match(r.content, /a\.txt:1:/);
});

test("case_insensitive flag", async () => {
  file("a.txt", "Needle\n");
  const miss = await Grep.run({ pattern: "needle" }, ctx);
  assert.match(miss.content, /No matches/);
  const hit = await Grep.run({ pattern: "needle", case_insensitive: true }, ctx);
  assert.match(hit.content, /Found 1 match/);
});

test("include glob filters by filename, with {a,b} alternation", async () => {
  file("x.mjs", "needle\n");
  file("x.txt", "needle\n");
  file("x.ts", "needle\n");
  const onlyMjs = await Grep.run({ pattern: "needle", include: "*.mjs" }, ctx);
  assert.match(onlyMjs.content, /Found 1 match/);
  assert.match(onlyMjs.content, /x\.mjs:1:/);
  const alt = await Grep.run({ pattern: "needle", include: "*.{mjs,ts}" }, ctx);
  assert.match(alt.content, /Found 2 matches/);
  assert.ok(!alt.content.includes("x.txt"));
});

test("vendor and VCS dirs are skipped, hidden files are searched", async () => {
  file("node_modules/pkg/index.js", "needle\n");
  file(".git/config", "needle\n");
  file(".env", "needle\n");
  const r = await Grep.run({ pattern: "needle" }, ctx);
  assert.match(r.content, /Found 1 match in 1 file\./);
  assert.match(r.content, /\.env:1:/);
});

test("binary files (NUL in first 8 KiB) are skipped", async () => {
  // The pattern must stay intact next to the NUL — otherwise this test
  // passes even without the skip (the NUL would break the match itself,
  // as a mutation run proved).
  writeFileSync(join(root, "bin.dat"), Buffer.concat([Buffer.from([0x00]), Buffer.from("needle\n")]));
  file("text.txt", "needle\n");
  const r = await Grep.run({ pattern: "needle" }, ctx);
  assert.match(r.content, /Found 1 match/);
  assert.ok(!r.content.includes("bin.dat"));
});

test("files over 512 KiB are skipped", async () => {
  writeFileSync(join(root, "big.txt"), "needle\n" + "x".repeat(600 * 1024));
  file("small.txt", "needle\n");
  const r = await Grep.run({ pattern: "needle" }, ctx);
  assert.match(r.content, /Found 1 match/);
  assert.match(r.content, /small\.txt:1:/);
});

test("max_results caps output and flags truncation", async () => {
  file("many.txt", Array.from({ length: 20 }, () => "needle").join("\n"));
  const r = await Grep.run({ pattern: "needle", max_results: 5 }, ctx);
  assert.match(r.content, /Found 5 matches .*\(truncated\)\./);
  assert.equal(r.content.split("\n").length, 6); // header + 5 result lines
});

test("very long matching lines are truncated at 240 chars", async () => {
  file("long.txt", "needle " + "y".repeat(500) + "\n");
  const r = await Grep.run({ pattern: "needle" }, ctx);
  const resultLine = r.content.split("\n")[1];
  assert.ok(resultLine.includes("…"), "truncation marker expected");
  assert.ok(resultLine.length < 300, `line should be truncated, got ${resultLine.length} chars`);
});

test("no matches reports the files-visited count instead of an empty string", async () => {
  file("a.txt", "nothing\n");
  const r = await Grep.run({ pattern: "needle" }, ctx);
  assert.notEqual(r.isError, true);
  assert.match(r.content, /No matches for \/needle\/ in \. \(visited \d+ files\)\./);
});

test("invalid regex is a clean tool error", async () => {
  const r = await Grep.run({ pattern: "(unclosed" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content, /invalid regex/);
});

test("missing / non-directory path is a clean tool error", async () => {
  const missing = await Grep.run({ pattern: "x", path: "nope" }, ctx);
  assert.equal(missing.isError, true);
  assert.match(missing.content, /does not exist/);
  file("afile.txt", "x\n");
  const notDir = await Grep.run({ pattern: "x", path: "afile.txt" }, ctx);
  assert.equal(notDir.isError, true);
  assert.match(notDir.content, /not a directory/);
});

test("an aborted signal stops the walk", async () => {
  for (let i = 0; i < 20; i++) file(`f${i}.txt`, "needle\n");
  const ac = new AbortController();
  ac.abort();
  const r = await Grep.run({ pattern: "needle" }, { ...ctx, signal: ac.signal });
  // Pre-aborted: the walk visits nothing, so nothing can match.
  assert.match(r.content, /No matches/);
});
