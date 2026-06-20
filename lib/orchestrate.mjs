// Shared run-orchestration helpers for the CLI runner and the inline (--wait)
// path. This is the logic that mcp/server.mjs used to carry inline: resolve
// the LLM profile for a thread and build its sandbox from the agent def.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSandbox } from "./sandbox.mjs";
import { createWorkspaceStore } from "./workspace-store.mjs";
import { createProfileStore } from "./profiles.mjs";
import { buildToolPolicy } from "./agent-defs.mjs";
import { resolveUserDir } from "./data-dir.mjs";

// Plugin root = one level up from lib/orchestrate.mjs.
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Resolve the LLM profile for a thread at call time. Never stored in meta —
 * always re-derived from agentDef.model via the workspace's modelProfileMappings,
 * so profile/mapping changes take effect on the next run without touching the thread.
 */
export async function resolveProfile(thread) {
  const store = createWorkspaceStore(thread.cwd);
  const profileStore = createProfileStore({ dataDir: resolveUserDir() });
  const modelIdentifier = thread.agentDef?.model || "_default";
  const profileName = await store.resolveModelToProfile(modelIdentifier);
  return profileStore.get(profileName);
}

/** Build the sandbox for a thread from its agent def's tool policy. */
export function makeSandbox(thread, registry) {
  const availableTools = registry.list().map((t) => t.name);
  const policy = thread.agentDef ? buildToolPolicy(thread.agentDef, availableTools) : {};
  return createSandbox({ root: thread.cwd, policy });
}
