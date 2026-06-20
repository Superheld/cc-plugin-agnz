import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandbox } from "../lib/sandbox.mjs";
import Edit from "../lib/tools/Edit.mjs";

function setup(content) {
  const root = mkdtempSync(join(tmpdir(), "agnz-edit-"));
  writeFileSync(join(root, "f.txt"), content);
  return { ctx: { sandbox: createSandbox({ root, policy: {} }) }, file: join(root, "f.txt") };
}
const read = (f) => readFileSync(f, "utf8");

test("replace a unique anchor", async () => {
  const { ctx, file } = setup("a\nreturn x + y;\nb\n");
  const r = await Edit.run({ path: "f.txt", old_string: "return x + y;", new_string: "return x - y;" }, ctx);
  assert.equal(r.isError, undefined);
  assert.match(read(file), /return x - y;/);
});

test("tolerates a pasted Read line-number prefix", async () => {
  const { ctx, file } = setup("a\nreturn x + y;\nb\n");
  await Edit.run({ path: "f.txt", old_string: "    2  return x + y;", new_string: "Z" }, ctx);
  assert.match(read(file), /\nZ\n/);
});

test("non-unique anchor: errors without hint, resolves with line hint", async () => {
  let s = setup("dup\nmid\ndup\n");
  const r = await Edit.run({ path: "f.txt", old_string: "dup", new_string: "X" }, s.ctx);
  assert.equal(r.isError, true);
  s = setup("dup\nmid\ndup\n");
  await Edit.run({ path: "f.txt", old_string: "dup", new_string: "X", line: 3 }, s.ctx);
  assert.equal(read(s.file), "dup\nmid\nX\n");
});

test("insert after and before the anchor", async () => {
  let s = setup("line1\nline2\n");
  await Edit.run({ path: "f.txt", old_string: "line1\n", new_string: "ins\n", mode: "after" }, s.ctx);
  assert.equal(read(s.file), "line1\nins\nline2\n");
  s = setup("line1\nline2\n");
  await Edit.run({ path: "f.txt", old_string: "line2", new_string: "ins\n", mode: "before" }, s.ctx);
  assert.equal(read(s.file), "line1\nins\nline2\n");
});

test("anchor not found errors loudly (no silent corruption)", async () => {
  const { ctx } = setup("hello\n");
  const r = await Edit.run({ path: "f.txt", old_string: "nope", new_string: "x" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content, /not found/);
});
