// Unified configuration (ADR 0017). One schema, two layers, project wins:
//
//   ~/.claude/agnz/config.json        machine-level defaults
//   <cwd>/.claude/agnz/config.json    optional project overrides, committable
//
// Shape (both layers identical):
//
//   {
//     "profiles": { "<name>": { baseUrl, model, apiKey?, temperature?, maxTokens?, maxTurns?, llmTimeoutMs?, contextWindow?, compactThreshold? } },
//     "mappings": { "_default": "<profile>", "<agentDef.model>": "<profile>" }
//   }
//
// This replaces profiles.json (user) and workspace.json's
// modelProfileMappings (project). The merge is per-entry: a project may
// override one profile or one mapping without restating the rest. Model
// resolution: mappings[model] → mappings._default → model treated as a
// profile name directly.

import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { resolveUserDir, resolveProjectDir } from "./data-dir.mjs";
import { atomicWriteFile } from "./atomic-write.mjs";

export const CONFIG_FILE = "config.json";

function userConfigFile() {
  return join(resolveUserDir(), CONFIG_FILE);
}
function projectConfigFile(cwd) {
  return join(resolveProjectDir(resolve(cwd)), CONFIG_FILE);
}

/**
 * Shape validation for a single profile. Returns the normalised profile or
 * throws with a human-readable message. (Ported from the retired
 * profiles.mjs — llmTimeoutMs stays an explicit opt-in, no default deadline.)
 */
export function normaliseProfile(name, p) {
  if (!p || typeof p !== "object") throw new Error(`profile '${name}': not an object`);
  if (typeof p.baseUrl !== "string" || !p.baseUrl) {
    throw new Error(`profile '${name}': baseUrl is required`);
  }
  if (typeof p.model !== "string" || !p.model) {
    throw new Error(`profile '${name}': model is required`);
  }
  return {
    baseUrl: p.baseUrl,
    apiKey: p.apiKey ?? null,
    model: p.model,
    temperature: typeof p.temperature === "number" ? p.temperature : 0.2,
    maxTokens: typeof p.maxTokens === "number" ? p.maxTokens : null,
    maxTurns: typeof p.maxTurns === "number" ? p.maxTurns : 20,
    llmTimeoutMs: typeof p.llmTimeoutMs === "number" ? p.llmTimeoutMs : null,
    // Context compaction (context-diet 3/3) is opt-in: it fires only when the
    // user states the model's window here (the API does not expose it).
    contextWindow: typeof p.contextWindow === "number" ? p.contextWindow : null,
    compactThreshold: typeof p.compactThreshold === "number" ? p.compactThreshold : 0.9,
  };
}

async function readLayer(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  const json = JSON.parse(raw);
  return {
    profiles: json.profiles && typeof json.profiles === "object" ? json.profiles : {},
    mappings: json.mappings && typeof json.mappings === "object" ? json.mappings : {},
  };
}

/**
 * The pre-ADR-0017 layout is not migrated (deliberate: breaking change,
 * fresh setup). But it must fail LOUDLY, not as a mysterious "no such
 * profile": if the user layer is absent while the legacy profiles.json
 * exists, the user upgraded the plugin over an old install.
 */
function legacyCheck(userLayer) {
  if (userLayer !== null) return;
  const legacy = join(resolveUserDir(), "profiles.json");
  if (existsSync(legacy)) {
    throw new Error(
      "config: found the pre-0.18 profiles.json but no config.json — the config layout " +
        "changed (ADR 0017, breaking). Re-run /agnz:setup to create the new config; " +
        "the old profiles.json is ignored and can be deleted.",
    );
  }
}

/**
 * Load the effective merged config for a project. Each returned entry
 * carries its origin ("user" | "project") so surfaces like `setup info`
 * can render where a value came from.
 */
export async function loadConfig(cwd) {
  const [userLayer, projectLayer] = await Promise.all([
    readLayer(userConfigFile()),
    cwd ? readLayer(projectConfigFile(cwd)) : Promise.resolve(null),
  ]);
  legacyCheck(userLayer);

  const profiles = {};
  const mappings = {};
  for (const [layer, origin] of [
    [userLayer, "user"],
    [projectLayer, "project"],
  ]) {
    if (!layer) continue;
    for (const [name, p] of Object.entries(layer.profiles)) {
      profiles[name] = { ...normaliseProfile(name, p), name, origin };
    }
    for (const [model, profileName] of Object.entries(layer.mappings)) {
      mappings[model] = { profile: profileName, origin };
    }
  }
  return { profiles, mappings };
}

/**
 * Resolve which profile serves a given agentDef.model in a project.
 * Chain: mappings[model] → mappings._default → model as profile name.
 * Returns the full profile object (with name/origin) or null.
 */
export async function resolveProfileForModel(cwd, modelIdentifier) {
  const { profiles, mappings } = await loadConfig(cwd);
  const id = modelIdentifier || "_default";
  const mapped = mappings[id]?.profile ?? mappings["_default"]?.profile ?? id;
  return profiles[mapped] || null;
}

/**
 * Read-modify-write one layer's config file. `scope` is "user" or
 * "project" (project requires cwd). `mutate(current)` receives the raw
 * layer ({profiles, mappings}, empty when the file is new) and returns
 * the layer to persist.
 */
export async function updateConfigLayer(scope, cwd, mutate) {
  const file =
    scope === "project"
      ? projectConfigFile(requireCwd(cwd))
      : userConfigFile();
  const current = (await readLayer(file)) ?? { profiles: {}, mappings: {} };
  const next = await mutate(current);
  await mkdir(dirname(file), { recursive: true });
  await atomicWriteFile(file, JSON.stringify(next, null, 2) + "\n");
  return { file, config: next };
}

function requireCwd(cwd) {
  if (!cwd) throw new Error("config: project scope requires a cwd");
  return cwd;
}
