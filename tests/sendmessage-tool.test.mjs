// Direct unit tests for lib/tools/SendMessage.mjs — the sub-agent's only
// publishing surface (ADR 0002). Pins the argument validation (kind enum,
// to normalisation) and the actual publish path into messages.jsonl.
//
// Note: tests never send urgent mail addressed to "parent" — that path
// fires a real OS notification via notifier.mjs.
//
// Run with: node --test tests/sendmessage-tool.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSandbox } from "../lib/sandbox.mjs";
import { readAllMessages } from "../lib/messages-log.mjs";
import SendMessage from "../lib/tools/SendMessage.mjs";

let root;
let ctx;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agnz-sendmsg-"));
  ctx = { sandbox: createSandbox({ root, policy: {} }), agentName: "tester" };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test("happy path publishes to messages.jsonl and returns the id", async () => {
  const r = await SendMessage.run({ to: "parent", kind: "say", text: "done" }, ctx);
  assert.notEqual(r.isError, true);
  assert.match(r.content, /^sent m\d{6}$/);

  const all = await readAllMessages(root);
  assert.equal(all.length, 1);
  assert.equal(all[0].from, "tester");
  assert.equal(all[0].to, "parent");
  assert.equal(all[0].kind, "say");
  assert.equal(all[0].text, "done");
  assert.equal(all[0].urgent, false);
});

test("message ids are monotonic across sends", async () => {
  const a = await SendMessage.run({ to: "x", kind: "say", text: "1" }, ctx);
  const b = await SendMessage.run({ to: "x", kind: "say", text: "2" }, ctx);
  const idOf = (r) => r.content.replace("sent ", "");
  assert.ok(idOf(b) > idOf(a), `${idOf(b)} must sort after ${idOf(a)}`);
});

test("array recipients are preserved", async () => {
  await SendMessage.run({ to: ["dev", "reviewer"], kind: "handoff", text: "yours" }, ctx);
  const all = await readAllMessages(root);
  assert.deepEqual(all[0].to, ["dev", "reviewer"]);
});

test("optional item_id / ref / urgent fields round-trip", async () => {
  await SendMessage.run(
    { to: "dev", kind: "answer", text: "42", item_id: "b-1", ref: "m000007", urgent: true },
    ctx,
  );
  const all = await readAllMessages(root);
  assert.equal(all[0].item_id, "b-1");
  assert.equal(all[0].ref, "m000007");
  assert.equal(all[0].urgent, true);
});

test("unknown kind is rejected with the enum in the message", async () => {
  const r = await SendMessage.run({ to: "parent", kind: "shout", text: "hi" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content, /kind must be one of say, question, answer/);
  assert.equal((await readAllMessages(root)).length, 0, "nothing may be published");
});

test("empty text is rejected", async () => {
  const r = await SendMessage.run({ to: "parent", kind: "say", text: "" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content, /text must be a non-empty string/);
});

test("invalid recipients are rejected: empty string, empty array, non-string entry", async () => {
  for (const to of ["", [], ["dev", ""], ["dev", 42]]) {
    const r = await SendMessage.run({ to, kind: "say", text: "hi" }, ctx);
    assert.equal(r.isError, true, `to=${JSON.stringify(to)} must be rejected`);
  }
  const notStringOrArray = await SendMessage.run({ to: 7, kind: "say", text: "hi" }, ctx);
  assert.equal(notStringOrArray.isError, true);
  assert.match(notStringOrArray.content, /string or array/);
  assert.equal((await readAllMessages(root)).length, 0);
});

test("falls back to 'agent' when ctx carries no agentName", async () => {
  await SendMessage.run({ to: "dev", kind: "status", text: "hi" }, { sandbox: ctx.sandbox });
  const all = await readAllMessages(root);
  assert.equal(all[0].from, "agent");
});
