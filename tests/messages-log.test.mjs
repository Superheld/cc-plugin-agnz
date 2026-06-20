import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMessage, readAllMessages } from "../lib/messages-log.mjs";

const freshCwd = () => mkdtempSync(join(tmpdir(), "agnz-ml-"));

test("monotonic ids; concurrent appends stay unique and contiguous", async () => {
  const cwd = freshCwd();
  await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      appendMessage(cwd, { from: "a", to: "parent", kind: "say", text: String(i) }),
    ),
  );
  const all = await readAllMessages(cwd);
  const ids = all.map((m) => m.id);
  assert.equal(all.length, 25);
  assert.equal(new Set(ids).size, 25);
  assert.equal(ids[0], "m000001");
  assert.equal(ids[24], "m000025");
});

test("corrupt last line does NOT reset the id sequence", async () => {
  const cwd = freshCwd();
  await appendMessage(cwd, { from: "a", to: "parent", kind: "say", text: "one" });
  appendFileSync(join(cwd, ".claude", "agnz", "messages.jsonl"), "NOT JSON\n");
  const m = await appendMessage(cwd, { from: "a", to: "parent", kind: "say", text: "two" });
  assert.equal(m.id, "m000002");
});
