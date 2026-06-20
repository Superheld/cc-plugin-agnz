// Profiles: named {baseUrl, apiKey, model, ...} bundles. Stored in
// data/profiles.json. Multiple profiles so the user can switch between
// LM Studio, Ollama, OpenRouter, etc. without editing config.
// 
// NOTE: The `activeProfile` field is ONLY for UI convenience (e.g., showing which profile
// is "current" during setup commands). It has NO effect on agent_start time —
// the MCP server resolves profiles via workspace mappings and does NOT consult
// activeProfile at startup. This is intentional to keep the startup logic clean.

import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { listModels } from "./llm/openai-compatible.mjs";
import { atomicWriteFile } from "./atomic-write.mjs";

const SCHEMA_VERSION = 1;

function emptyStore() {
  return {
    version: SCHEMA_VERSION,
    activeProfile: null,
    profiles: {},
  };
}

/**
 * Shape validation for a single profile. Returns the normalised profile
 * or throws with a human-readable message.
 */
function normaliseProfile(name, p) {
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
    // null → use the client's DEFAULT_TIMEOUT_MS (10 min). Set to a larger
    // value if your local model is unusually slow (e.g. large model on CPU).
    llmTimeoutMs: typeof p.llmTimeoutMs === "number" ? p.llmTimeoutMs : null,
  };
}

export function createProfileStore({ dataDir }) {
  if (!dataDir) throw new Error("profiles: dataDir is required");
  const file = join(resolve(dataDir), "profiles.json");

  async function load() {
    try {
      const raw = await readFile(file, "utf8");
      const json = JSON.parse(raw);
      if (json.version !== SCHEMA_VERSION) {
        throw new Error(
          `profiles: unsupported schema version ${json.version} (expected ${SCHEMA_VERSION})`,
        );
      }
      return json;
    } catch (err) {
      if (err.code === "ENOENT") return emptyStore();
      throw err;
    }
  }

  async function save(store) {
    await mkdir(dirname(file), { recursive: true });
    await atomicWriteFile(file, JSON.stringify(store, null, 2));
  }

  async function list() {
    const store = await load();
    return {
      active: store.activeProfile,
      profiles: Object.entries(store.profiles).map(([name, p]) => ({ name, ...p })),
    };
  }

  async function get(name) {
    const store = await load();
    const target = name || store.activeProfile;
    if (!target) return null;
    const p = store.profiles[target];
    if (!p) return null;
    // Normalise on read too (not just on add): fills defaults and surfaces a
    // clear error for a hand-edited profile instead of a cryptic failure at
    // request time.
    return { name: target, ...normaliseProfile(target, p) };
  }

  async function add(name, raw) {
    if (!name || typeof name !== "string") throw new Error("profiles: name is required");
    const store = await load();
    store.profiles[name] = normaliseProfile(name, raw);
    if (!store.activeProfile) store.activeProfile = name;
    await save(store);
    return store.profiles[name];
  }

  async function remove(name) {
    const store = await load();
    if (!store.profiles[name]) throw new Error(`profiles: no such profile '${name}'`);
    delete store.profiles[name];
    if (store.activeProfile === name) {
      const remaining = Object.keys(store.profiles);
      store.activeProfile = remaining.length ? remaining[0] : null;
    }
    await save(store);
  }

  async function use(name) {
    const store = await load();
    if (!store.profiles[name]) throw new Error(`profiles: no such profile '${name}'`);
    store.activeProfile = name;
    await save(store);
  }

  /**
   * Ping the profile's baseUrl by calling /models. Returns the list of
   * models seen (possibly empty) or throws a descriptive error.
   */
  async function test(name) {
    const p = await get(name);
    if (!p) throw new Error(`profiles: no such profile '${name || "(active)"}'`);
    const models = await listModels({ baseUrl: p.baseUrl, apiKey: p.apiKey });
    const seesModel = p.model && models.includes(p.model);
    return { name: p.name, baseUrl: p.baseUrl, models, seesConfiguredModel: seesModel };
  }

  return { load, save, list, get, add, remove, use, test };
}
