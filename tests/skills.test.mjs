// node:test coverage for lib/skills.mjs frontmatter parsing.
//
// Regression guard for the block-scalar bug: a SKILL.md whose description
// used a YAML block scalar (`description: >`) yielded the literal ">" as
// the description and silently dropped the indented continuation lines.
// parseSkillMd is pure over a string, so we exercise it directly rather
// than through the filesystem discovery layer.
//
// Run with: node --test tests/skills.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSkillMd } from "../lib/skills.mjs";

test("plain key: value scalars parse unchanged", () => {
  const src = [
    "---",
    "name: my-skill",
    "description: A one-line description.",
    "---",
    "Body text.",
  ].join("\n");
  const out = parseSkillMd(src, "dir-name");
  assert.equal(out.name, "my-skill");
  assert.equal(out.description, "A one-line description.");
  assert.equal(out.body, "Body text.");
});

test("folded (>) block scalar joins continuation lines with spaces", () => {
  const src = [
    "---",
    "name: folded",
    "description: >",
    "  Expert guidance for writing things.",
    "  Covers many cases and edge conditions.",
    "---",
    "Body.",
  ].join("\n");
  const out = parseSkillMd(src, "folded");
  assert.equal(
    out.description,
    "Expert guidance for writing things. Covers many cases and edge conditions.",
  );
  assert.equal(out.body, "Body.");
});

test("folded (>) turns a blank line into a paragraph break", () => {
  const src = [
    "---",
    "description: >",
    "  Paragraph one continues here.",
    "",
    "  Paragraph two.",
    "---",
  ].join("\n");
  const out = parseSkillMd(src, "d");
  assert.equal(out.description, "Paragraph one continues here.\nParagraph two.");
});

test("literal (|) block scalar preserves newlines", () => {
  const src = [
    "---",
    "name: literal",
    "description: |",
    "  line one",
    "  line two",
    "---",
  ].join("\n");
  const out = parseSkillMd(src, "literal");
  assert.equal(out.description, "line one\nline two");
});

test("chomping variants (>- |+ etc.) are recognized as block scalars", () => {
  for (const indicator of [">-", ">+", "|-", "|+"]) {
    const src = [
      "---",
      `description: ${indicator}`,
      "  real prose here",
      "  second line",
      "---",
    ].join("\n");
    const out = parseSkillMd(src, "d");
    // The indicator itself must never leak into the value.
    assert.doesNotMatch(out.description, /^[>|]/);
    assert.match(out.description, /real prose here/);
    if (indicator[0] === "|") {
      assert.equal(out.description, "real prose here\nsecond line");
    } else {
      assert.equal(out.description, "real prose here second line");
    }
  }
});

test("block scalar as the LAST frontmatter key is closed by the --- fence", () => {
  const src = [
    "---",
    "name: last-key",
    "description: >",
    "  first",
    "  second",
    "---",
    "The body survives.",
  ].join("\n");
  const out = parseSkillMd(src, "last-key");
  assert.equal(out.description, "first second");
  assert.equal(out.body, "The body survives.");
});

test("a key after a block scalar still parses (indicator does not swallow it)", () => {
  const src = [
    "---",
    "description: >",
    "  folded description text",
    "name: after-block",
    "---",
    "Body.",
  ].join("\n");
  const out = parseSkillMd(src, "dir");
  assert.equal(out.description, "folded description text");
  assert.equal(out.name, "after-block");
});

test("missing description falls back to empty string", () => {
  const src = ["---", "name: only-name", "---", "Body."].join("\n");
  const out = parseSkillMd(src, "dir");
  assert.equal(out.name, "only-name");
  assert.equal(out.description, "");
});

test("an empty folded scalar leaves the description empty", () => {
  const src = ["---", "name: n", "description: >", "---", "Body."].join("\n");
  const out = parseSkillMd(src, "dir");
  assert.equal(out.description, "");
});

test("no frontmatter: whole source is the body, named by dir", () => {
  const out = parseSkillMd("Just a body, no fence.", "the-dir");
  assert.equal(out.name, "the-dir");
  assert.equal(out.description, "");
  assert.equal(out.body, "Just a body, no fence.");
});

test("value containing a '>' mid-line is not treated as a block scalar", () => {
  const src = ["---", "description: use a > b for greater-than", "---"].join("\n");
  const out = parseSkillMd(src, "d");
  assert.equal(out.description, "use a > b for greater-than");
});
