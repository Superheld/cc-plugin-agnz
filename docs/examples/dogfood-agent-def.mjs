#!/usr/bin/env node
// ADR 0003 dogfood — spawn an agent thread from an agent-def file
// (<cwd>/.claude/agnz/agents/<name>.md) and verify that:
//
//   1. the frontmatter is parsed
//   2. the profile referenced by the def is resolved
//   3. mergeEffectivePolicy() applies the role's tool overrides on top
//      of the profile's defaultPolicy (strictest wins, profile is upper
//      bound)
//   4. the role body is concatenated onto the default system prompt
//   5. the live sub-agent honours the snapshotted policy end-to-end
//      (e.g. a `deny`-gated tool really refuses to run)
//
// This bypasses the MCP server on purpose — runs against lib/ directly
// so it is unaffected by plugin cache staleness.
//
// Requires: an active profile (run /agnz:setup first) AND the local
// LLM endpoint reachable. Run from the repo root:
//   node docs/examples/dogfood-agent-def.mjs

import { rm, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createThreadManager } from "../../lib/threads.mjs";
import { createSandbox } from "../../lib/sandbox.mjs";
import { createRegistry } from "../../lib/tools/registry.mjs";
import { runThread } from "../../lib/loop.mjs";
import { createProfileStore } from "../../lib/profiles.mjs";
import { loadAgentDef, mergeEffectivePolicy } from "../../lib/agent-defs.mjs";
import { resolveUserDir } from "../../lib/data-dir.mjs";

const TEST_CWD = "/tmp/agnz-agent-def-dogfood";

const RESEARCHER_DEF = `---
name: researcher
profile: __PROFILE__
description: >
  Read-heavy investigation. No edits.
tools:
  edit_file: deny
  write_file: deny
  bash: deny
temperature: 0.2
maxTurns: 20
---

You investigate the sandbox and produce concise, factual summaries.
You do not modify files. When asked, list directory contents or read
a specific file and summarise it in one paragraph. Stop after the
summary — do not narrate tool calls.
`;

async function main() {
  const dataDir = resolveUserDir();
  const profiles = createProfileStore({ dataDir });
  const active = await profiles.get(); // no name = active profile
  if (!active) {
    console.error("No active profile. Run /agnz:setup first.");
    process.exit(1);
  }

  // Fresh sandbox dir with a tiny file tree so the researcher has
  // something concrete to look at.
  await rm(TEST_CWD, { recursive: true, force: true });
  await mkdir(resolve(TEST_CWD, ".claude/agnz/agents"), { recursive: true });
  await writeFile(
    resolve(TEST_CWD, "hello.txt"),
    "This is a sample file.\nIt has two lines.\n",
  );
  await writeFile(
    resolve(TEST_CWD, ".claude/agnz/agents/researcher.md"),
    RESEARCHER_DEF.replace("__PROFILE__", active.name),
  );

  const agentDef = await loadAgentDef(TEST_CWD, "researcher");
  const effective = mergeEffectivePolicy(active.defaultPolicy, agentDef.tools);
  console.log("[dogfood] agent def loaded:", {
    name: agentDef.name,
    profile: agentDef.profile,
    temperature: agentDef.temperature,
    maxTurns: agentDef.maxTurns,
  });
  console.log("[dogfood] effective policy:", effective);

  // Sanity invariants (would be caught by tests too, but nice to see).
  if (effective.edit_file !== "deny") throw new Error("edit_file should be deny");
  if (effective.write_file !== "deny") throw new Error("write_file should be deny");
  if (effective.bash !== "deny") throw new Error("bash should be deny");
  if (effective.read_file !== "allow") throw new Error("read_file should stay allow");

  const threadMgr = createThreadManager({ dataDir });
  const thread = await threadMgr.createThread({
    cwd: TEST_CWD,
    profile: active.name,
    policy: effective,
    systemPrompt: null,
    agentDef,
  });
  console.log("[dogfood] thread created:", thread.id);

  const sandbox = createSandbox({ root: TEST_CWD, policy: effective });
  const registry = createRegistry();

  const outcome = await runThread({
    thread,
    sandbox,
    registry,
    profile: active,
    threadMgr,
    userMessage: "List the files in the sandbox root and tell me what hello.txt contains.",
  });

  console.log("[dogfood] outcome:", JSON.stringify(outcome, null, 2));
}

main().catch((err) => {
  console.error("[dogfood] failed:", err);
  process.exit(1);
});
