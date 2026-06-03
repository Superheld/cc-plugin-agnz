// node:test coverage for lib/sandbox.mjs (ADR 0011 §4).
//
// The sandbox is the security boundary: path-escape refusal, symlink-escape
// protection, and the three permission decisions. None of this was tested.
//
// Run with: node --test tests/sandbox.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSandbox, Decision } from "../lib/sandbox.mjs";

let root;
let outside;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agnz-sb-root-"));
  outside = mkdtempSync(join(tmpdir(), "agnz-sb-out-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("createSandbox requires an existing directory root", () => {
  assert.throws(() => createSandbox({}), /root is required/);
  assert.throws(() => createSandbox({ root: join(root, "does-not-exist") }), /does not exist/);
});

test("resolvePath keeps in-root paths and refuses escapes", () => {
  const sb = createSandbox({ root });
  writeFileSync(join(root, "a.txt"), "x");

  // in-root, existing
  assert.equal(sb.resolvePath("a.txt"), join(realpathSync(root), "a.txt"));
  // in-root, not yet existing (write target) is allowed
  assert.equal(sb.resolvePath("sub/new.txt"), join(realpathSync(root), "sub/new.txt"));
  // the root itself
  assert.equal(sb.resolvePath("."), realpathSync(root));

  // relative escape
  assert.throws(() => sb.resolvePath("../escape.txt"), /escapes root/);
  // absolute path outside root
  assert.throws(() => sb.resolvePath(join(outside, "x.txt")), /escapes root/);
  // empty path
  assert.throws(() => sb.resolvePath(""), /non-empty string/);
});

test("resolvePath refuses a symlink that points outside the root", () => {
  writeFileSync(join(outside, "secret.txt"), "top secret");
  // root/link -> outside  (a symlink escape)
  symlinkSync(outside, join(root, "link"));

  const sb = createSandbox({ root });
  assert.throws(() => sb.resolvePath("link/secret.txt"), /escapes root/);
  assert.throws(() => sb.resolvePath("link"), /escapes root/);
});

test("checkPermission returns the policy value, defaulting to ask", () => {
  const sb = createSandbox({ root, policy: { Read: Decision.ALLOW, Bash: Decision.DENY } });
  assert.equal(sb.checkPermission("Read"), Decision.ALLOW);
  assert.equal(sb.checkPermission("Bash"), Decision.DENY);
  // anything unlisted is "ask"
  assert.equal(sb.checkPermission("Write"), Decision.ASK);
  assert.equal(sb.checkPermission("Anything"), Decision.ASK);
});

test("recordDecision upgrades a tool's policy and validates input", () => {
  const sb = createSandbox({ root });
  assert.equal(sb.checkPermission("Write"), Decision.ASK);
  sb.recordDecision("Write", Decision.ALLOW);
  assert.equal(sb.checkPermission("Write"), Decision.ALLOW);
  assert.throws(() => sb.recordDecision("Write", "maybe"), /invalid decision/);
});

test("getRoot returns the realpath'd root and getPolicy is a copy", () => {
  const sb = createSandbox({ root, policy: { Read: Decision.ALLOW } });
  assert.equal(sb.getRoot(), realpathSync(root));
  const p = sb.getPolicy();
  p.Read = Decision.DENY; // mutating the copy must not affect the sandbox
  assert.equal(sb.checkPermission("Read"), Decision.ALLOW);
});
