// node:test coverage for lib/agent-defs.mjs block-scalar parsing.
//
// Companion to tests/skills.test.mjs. The agent-def parser already collected
// continuation lines for `>` and `|`, so it never had the drop-the-body bug
// skills.mjs had — but it matched the indicator with `rest === ">"`, so the
// chomping variants (`>-`, `|+`, ...) leaked the indicator into the value.
// These cases pin the folded/literal behaviour and guard the chomping fix.
//
// Run with: node --test tests/agent-defs.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseAgentDefSource } from "../lib/agent-defs.mjs";

test("plain scalar description parses unchanged", () => {
  const src = [
    "---",
    "name: dev",
    "description: A short role description.",
    "---",
    "System prompt body.",
  ].join("\n");
  const def = parseAgentDefSource(src, "dev.md");
  assert.equal(def.name, "dev");
  assert.equal(def.description, "A short role description.");
  assert.equal(def.body, "System prompt body.");
});

test("folded (>) description joins with spaces", () => {
  const src = [
    "---",
    "name: dev",
    "description: >",
    "  First half of the sentence",
    "  and the second half.",
    "---",
    "Body.",
  ].join("\n");
  const def = parseAgentDefSource(src, "dev.md");
  assert.equal(def.description, "First half of the sentence and the second half.");
});

test("literal (|) description preserves newlines", () => {
  const src = [
    "---",
    "name: dev",
    "description: |",
    "  line one",
    "  line two",
    "---",
    "Body.",
  ].join("\n");
  const def = parseAgentDefSource(src, "dev.md");
  assert.equal(def.description, "line one\nline two");
});

test("chomping variants (>- |+ etc.) do not leak the indicator", () => {
  for (const indicator of [">-", ">+", "|-", "|+"]) {
    const src = [
      "---",
      "name: dev",
      `description: ${indicator}`,
      "  real prose here",
      "  second line",
      "---",
      "Body.",
    ].join("\n");
    const def = parseAgentDefSource(src, "dev.md");
    assert.doesNotMatch(def.description, /^[>|]/);
    assert.match(def.description, /real prose here/);
    if (indicator[0] === "|") {
      assert.equal(def.description, "real prose here\nsecond line");
    } else {
      assert.equal(def.description, "real prose here second line");
    }
  }
});

test("sequence fields still parse alongside a block-scalar description", () => {
  const src = [
    "---",
    "name: dev",
    "description: >",
    "  Folded text.",
    "tools:",
    "  - Read",
    "  - Grep",
    "---",
    "Body.",
  ].join("\n");
  const def = parseAgentDefSource(src, "dev.md");
  assert.equal(def.description, "Folded text.");
  assert.deepEqual(def.tools, ["Read", "Grep"]);
});
