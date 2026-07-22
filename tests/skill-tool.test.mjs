// Direct unit tests for lib/tools/Skill.mjs — list/load actions, the
// agent-def allow-list filter, and the per-thread catalog cache.
//
// Isolation caveat: discoverSkills also reads the REAL ~/.claude/skills of
// whoever runs the suite. Tests therefore use uniquely-named project skills
// and never assert on catalog size or "no skills" states.
//
// Run with: node --test tests/skill-tool.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Skill from "../lib/tools/Skill.mjs";

let cwd;
let threadSeq = 0;

function addSkill(dirName, name, description, body) {
  const dir = join(cwd, ".claude", "skills", dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
  );
}

// The tool caches its catalog per thread id (module-level Map), so every
// test uses a fresh id to see its own fixture skills.
function makeCtx(agentDef = {}) {
  threadSeq += 1;
  return {
    thread: { id: `skilltest-${process.pid}-${threadSeq}`, cwd, agentDef },
    pluginRoot: null,
  };
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "agnz-skilltool-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

test("list shows project skills with their descriptions", async () => {
  addSkill("uniq-alpha", "agnz-test-alpha", "Alpha helper.", "Alpha body.");
  const r = await Skill.run({ action: "list" }, makeCtx());
  assert.notEqual(r.isError, true);
  assert.match(r.content, /^Available skills:/);
  assert.match(r.content, /- agnz-test-alpha: Alpha helper\./);
});

test("load returns the skill body", async () => {
  addSkill("uniq-beta", "agnz-test-beta", "Beta helper.", "The full beta instructions.");
  const r = await Skill.run({ action: "load", name: "agnz-test-beta" }, makeCtx());
  assert.notEqual(r.isError, true);
  assert.equal(r.content, "The full beta instructions.");
});

test("load of an unknown skill errors and suggests what exists", async () => {
  addSkill("uniq-gamma", "agnz-test-gamma", "Gamma.", "Body.");
  const r = await Skill.run({ action: "load", name: "no-such-skill" }, makeCtx());
  assert.equal(r.isError, true);
  assert.match(r.content, /skill 'no-such-skill' not found/);
  assert.match(r.content, /agnz-test-gamma/);
});

test("load without a name is a clean error", async () => {
  const r = await Skill.run({ action: "load" }, makeCtx());
  assert.equal(r.isError, true);
  assert.match(r.content, /name is required/);
});

test("the agent def's skills: list narrows what is visible", async () => {
  addSkill("uniq-allowed", "agnz-test-allowed", "In the list.", "Allowed body.");
  addSkill("uniq-hidden", "agnz-test-hidden", "Not in the list.", "Hidden body.");
  const ctx = makeCtx({ skills: ["agnz-test-allowed"] });

  const list = await Skill.run({ action: "list" }, ctx);
  assert.match(list.content, /agnz-test-allowed/);
  assert.ok(!list.content.includes("agnz-test-hidden"));

  const denied = await Skill.run({ action: "load", name: "agnz-test-hidden" }, ctx);
  assert.equal(denied.isError, true, "a filtered skill must not be loadable");
});

test("the allow-list also matches by directory name", async () => {
  addSkill("uniq-dirname", "agnz-test-dirnamed", "Dir-matched.", "Body.");
  const ctx = makeCtx({ skills: ["uniq-dirname"] });
  const r = await Skill.run({ action: "load", name: "agnz-test-dirnamed" }, ctx);
  assert.equal(r.content, "Body.");
});

test("the catalog is cached per thread: same thread stale, new thread fresh", async () => {
  addSkill("uniq-first", "agnz-test-first", "First.", "Body.");
  const ctx = makeCtx();
  await Skill.run({ action: "list" }, ctx);

  addSkill("uniq-late", "agnz-test-late", "Added after first call.", "Body.");
  const stale = await Skill.run({ action: "list" }, ctx);
  assert.ok(!stale.content.includes("agnz-test-late"), "same thread reuses its catalog");

  const fresh = await Skill.run({ action: "list" }, makeCtx());
  assert.match(fresh.content, /agnz-test-late/);
});

test("unknown action is a clean error", async () => {
  const r = await Skill.run({ action: "reload" }, makeCtx());
  assert.equal(r.isError, true);
  assert.match(r.content, /unknown action 'reload'/);
});
