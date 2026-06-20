import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandbox } from "../lib/sandbox.mjs";

function setup() {
  const base = mkdtempSync(join(tmpdir(), "agnz-sbx-"));
  const root = join(base, "root");
  mkdirSync(root);
  const outside = join(base, "outside");
  mkdirSync(outside);
  return { root, outside, sb: createSandbox({ root, policy: {} }) };
}

test("resolvePath rejects .. escape", () => {
  const { sb } = setup();
  assert.throws(() => sb.resolvePath("../../etc/passwd"), /escapes root/);
});

test("resolvePath rejects an existing symlink pointing outside", () => {
  const { root, outside, sb } = setup();
  symlinkSync(outside, join(root, "evil"));
  assert.throws(() => sb.resolvePath("evil/x"), /escapes root/);
});

test("assertInside passes inside dirs, catches symlink-to-outside (TOCTOU)", () => {
  const { root, outside, sb } = setup();
  mkdirSync(join(root, "good"));
  symlinkSync(outside, join(root, "evil"));
  assert.doesNotThrow(() => sb.assertInside(join(root, "good")));
  assert.throws(() => sb.assertInside(join(root, "evil")), /escapes root/);
});
