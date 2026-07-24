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

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseSkillMd, discoverSkills } from "../lib/skills.mjs";

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

test("audience: lead keeps a skill out of the sub-agent catalog", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agnz-aud-"));
  const mk = (root, name, front) => {
    mkdirSync(join(dir, root, "skills", name), { recursive: true });
    writeFileSync(join(dir, root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n${front}\n---\nbody`);
  };
  mk("plugin", "lead-only", "audience: lead");
  mk("plugin", "for-agents", "audience: agent");
  mk("plugin", "unmarked", "");

  // Discovery also scans ~/.claude/skills, so assert on our fixtures only
  // rather than on an exact catalog that depends on the developer's machine.
  const catalog = await discoverSkills(join(dir, "proj"), join(dir, "plugin"));
  assert.ok(!catalog.has("lead-only"), "orchestration docs must not reach a worker");
  assert.ok(catalog.has("for-agents"), "an explicit agent audience stays available");
  assert.ok(catalog.has("unmarked"), "an absent audience field must not change anything");
  rmSync(dir, { recursive: true, force: true });
});

test("agnz's own skills are marked lead-only", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const catalog = await discoverSkills(join(root, "no-such-project"), root);
  assert.ok(!catalog.has("agnz"), "'delegate this to an agent' must not be in a worker's prompt");
  assert.ok(!catalog.has("agnz-setup"), "a worker has no business configuring profiles");
});

test("parseSkillMd surfaces the audience field, defaulting to null", () => {
  assert.equal(parseSkillMd("---\nname: a\ndescription: d\naudience: LEAD\n---\nb", "a").audience, "lead");
  assert.equal(parseSkillMd("---\nname: a\ndescription: d\n---\nb", "a").audience, null);
  assert.equal(parseSkillMd("no frontmatter", "a").audience, null);
});
