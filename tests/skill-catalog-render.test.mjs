// node:test coverage for finding G: a skill whose description is a multi-
// paragraph folded YAML block scalar must render as ONE line in the sub-agent
// system-prompt skill catalog. parseSkillMd maps paragraph breaks to "\n", and
// the loop's catalog render is the one description consumer that joins its lines
// raw — without a whitespace collapse an embedded newline injects an unframed
// line into the (cache-frozen) system prompt.
//
// We drive one runThread segment with a fake LLM and inspect the persisted
// systemPromptSnapshot, so this exercises the real render site end-to-end.
//
// Run with: node --test tests/skill-catalog-render.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createThreadManager } from "../lib/threads.mjs";
import { createSandbox } from "../lib/sandbox.mjs";
import { createRegistry } from "../lib/tools/registry.mjs";
import { runThread } from "../lib/loop.mjs";
import { fakeChat, finalMessage } from "./_fake-llm.mjs";

let projectCwd;
let userDir;

beforeEach(() => {
  projectCwd = mkdtempSync(join(tmpdir(), "agnz-skillcat-cwd-"));
  userDir = mkdtempSync(join(tmpdir(), "agnz-skillcat-user-"));
  process.env.AGNZ_DATA_DIR = userDir;

  // A project-local skill whose description spans two paragraphs via a folded
  // block scalar — parseSkillMd yields "para one\npara two".
  const skillDir = join(projectCwd, ".claude", "skills", "multipara");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: multipara-skill",
      "description: >",
      "  First line of the summary here.",
      "",
      "  Second paragraph after a blank line.",
      "---",
      "Body text.",
    ].join("\n"),
  );
});

afterEach(() => {
  delete process.env.AGNZ_DATA_DIR;
  rmSync(projectCwd, { recursive: true, force: true });
  rmSync(userDir, { recursive: true, force: true });
});

test("a multi-paragraph skill description renders as one catalog line", async () => {
  const threadMgr = createThreadManager();
  const thread = await threadMgr.createThread({
    cwd: projectCwd,
    name: "dev",
    agentDef: { name: "dev", tools: ["Read"] },
  });
  const sandbox = createSandbox({ root: projectCwd, policy: { Read: "allow" } });
  const registry = createRegistry();
  const profile = { baseUrl: "http://fake", model: "fake", name: "p" };

  await runThread({
    thread,
    threadMgr,
    sandbox,
    registry,
    profile,
    chat: fakeChat([finalMessage("done")]),
    userMessage: "hi",
  });

  const meta = await threadMgr.getThread(thread.id);
  const prompt = meta.systemPromptSnapshot;
  assert.equal(typeof prompt, "string");

  // The whole description sits on one collapsed line...
  assert.match(
    prompt,
    /- multipara-skill: First line of the summary here\. Second paragraph after a blank line\./,
  );
  // ...and the paragraph break is NOT a raw newline splitting the catalog.
  assert.ok(
    !prompt.includes("here.\nSecond paragraph"),
    "the folded paragraph break must not inject an unframed line",
  );
});
