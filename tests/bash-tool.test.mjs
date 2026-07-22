// Direct unit tests for lib/tools/Bash.mjs — the limit- and kill-critical
// tool. Everything here runs the real /bin/sh, so timing margins are kept
// generous (asserted upper bounds are multiples of the configured timeout)
// to stay robust under CI/parallel-suite I/O load.
//
// Run with: node --test tests/bash-tool.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSandbox } from "../lib/sandbox.mjs";
import Bash from "../lib/tools/Bash.mjs";

let root;
let ctx;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agnz-bash-"));
  ctx = { sandbox: createSandbox({ root, policy: {} }) };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test("happy path: stdout, stderr and exit_code round-trip as JSON", async () => {
  const r = await Bash.run({ command: "echo out; echo err 1>&2" }, ctx);
  assert.notEqual(r.isError, true);
  const parsed = JSON.parse(r.content);
  assert.equal(parsed.stdout, "out\n");
  assert.equal(parsed.stderr, "err\n");
  assert.equal(parsed.exit_code, 0);
});

test("non-zero exit sets isError but still returns the streams", async () => {
  const r = await Bash.run({ command: "echo partial; exit 3" }, ctx);
  assert.equal(r.isError, true);
  const parsed = JSON.parse(r.content);
  assert.equal(parsed.stdout, "partial\n");
  assert.equal(parsed.exit_code, 3);
});

test("commands run inside the sandbox root", async () => {
  const r = await Bash.run({ command: "echo marker > created-here.txt" }, ctx);
  assert.notEqual(r.isError, true);
  assert.ok(
    existsSync(join(realpathSync(root), "created-here.txt")),
    "the file must land in the sandbox root",
  );
});

test("timeout kills the command and reports the configured deadline", async () => {
  const started = Date.now();
  const r = await Bash.run({ command: "sleep 30", timeout_ms: 300 }, ctx);
  const elapsed = Date.now() - started;
  assert.equal(r.isError, true);
  assert.match(r.content, /timed out after 300ms/);
  assert.ok(elapsed < 5000, `must return promptly after the timeout, took ${elapsed}ms`);
});

test("timeout kills the whole process group, not just the shell", async () => {
  // The shell spawns a grandchild that writes a marker AFTER the timeout
  // window. If only the shell died, the orphaned sleep-chain would still
  // produce the file.
  const marker = join(root, "grandchild-survived.txt");
  const r = await Bash.run(
    { command: `(sleep 1; echo leaked > "${marker}") & wait`, timeout_ms: 300 },
    ctx,
  );
  assert.equal(r.isError, true);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.ok(!existsSync(marker), "the grandchild must have been killed with the group");
});

test("stdout over 1 MiB is capped with a clean error", async () => {
  // 2 MiB of zero bytes — trips the cap fast without generating text.
  const r = await Bash.run({ command: "dd if=/dev/zero bs=65536 count=32 2>/dev/null" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content, /stdout exceeded \d+ bytes/);
});

test("stderr over 1 MiB is capped with a clean error", async () => {
  // Redirect order matters: dup stdout onto the (real) stderr first, THEN
  // silence dd's own stats — otherwise the data lands in /dev/null too.
  const r = await Bash.run({ command: "dd if=/dev/zero bs=65536 count=32 1>&2 2>/dev/null" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content, /stderr exceeded \d+ bytes/);
});

test("output just under the cap passes through intact", async () => {
  // 512 KiB — well under the 1 MiB cap, big enough to need many pipe chunks.
  const r = await Bash.run({ command: "dd if=/dev/zero bs=65536 count=8 2>/dev/null | tr '\\0' 'a'" }, ctx);
  assert.notEqual(r.isError, true);
  const parsed = JSON.parse(r.content);
  assert.equal(parsed.stdout.length, 512 * 1024);
});

test("an abort signal mid-run kills the command", async () => {
  const ac = new AbortController();
  const started = Date.now();
  const p = Bash.run({ command: "sleep 30" }, { ...ctx, signal: ac.signal });
  setTimeout(() => ac.abort(), 150);
  const r = await p;
  assert.equal(r.isError, true);
  assert.match(r.content, /command aborted/);
  assert.ok(Date.now() - started < 5000, "abort must interrupt the sleep promptly");
});

test("a pre-aborted signal returns aborted without waiting for the command", async () => {
  const ac = new AbortController();
  ac.abort();
  const started = Date.now();
  const r = await Bash.run({ command: "sleep 30" }, { ...ctx, signal: ac.signal });
  assert.equal(r.isError, true);
  assert.match(r.content, /command aborted/);
  assert.ok(Date.now() - started < 5000, "must not wait out the sleep");
});
