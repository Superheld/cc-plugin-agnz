// Per-project workspace persistence, rooted at <cwd>/.claude/agnz/.
//
// ADR 0001 splits agnz state into two roots: a user-wide dir (profiles,
// global memory) and a per-project workspace. This module owns the
// per-project half. It is created with a single cwd and exposes the
// file operations the rest of the system needs for that project.
//
// Today the workspace store covers threads. Later steps will extend
// it with workspace.json (board), messages.jsonl (mailbox), and
// cursors/ (per-recipient read positions) per ADRs 0002 and 0004.
// The file layout is:
//
//   <cwd>/.claude/agnz/
//   ├── workspace.json           (step 1.3)
//   ├── threads/
//   │   ├── <id>.meta.json
//   │   └── <id>.jsonl
//   ├── messages.jsonl           (ADR 0002 implementation)
//   ├── cursors/                 (ADR 0002 implementation)
//   └── scratch/

import { mkdir, readFile, writeFile, appendFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { resolveProjectDir } from "./data-dir.mjs";

/**
 * Current schema version for workspace.json. Bump when the shape
 * changes and provide a migration path from the previous version.
 */
export const WORKSPACE_SCHEMA_VERSION = 1;

/**
 * Create a workspace store for a specific project cwd.
 * @param {string} cwd — absolute path to the project root
 */
export function createWorkspaceStore(cwd) {
  if (!cwd) throw new Error("workspace-store: cwd is required");
  const absCwd = resolve(cwd);
  const root = resolveProjectDir(absCwd);
  const threadsDir = join(root, "threads");
  const workspaceFile = join(root, "workspace.json");

  async function ensureDirs() {
    await mkdir(threadsDir, { recursive: true });
  }

  // ---- workspace.json ----
  //
  // The shared state for the workspace. Today this is a bare skeleton;
  // ADR 0002 adds `messages.jsonl` alongside it, ADR 0004 will populate
  // the `items`, `mode`, `reviewRequired` fields.

  function defaultWorkspace() {
    return {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      name: basename(absCwd),
      cwd: absCwd,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      members: [],
    };
  }

  async function readWorkspace() {
    try {
      const raw = await readFile(workspaceFile, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  async function writeWorkspace(ws) {
    await ensureDirs();
    const next = { ...ws, updatedAt: Date.now() };
    await writeFile(workspaceFile, JSON.stringify(next, null, 2), "utf8");
    return next;
  }

  /**
   * Load workspace.json, creating a default one if missing. This is
   * the entry point used by agent_start — the first thread in a new
   * project automatically initialises the workspace.
   */
  async function ensureWorkspace() {
    const existing = await readWorkspace();
    if (existing) return existing;
    return writeWorkspace(defaultWorkspace());
  }

  async function updateWorkspace(patch) {
    const current = (await readWorkspace()) || defaultWorkspace();
    return writeWorkspace({ ...current, ...patch });
  }

  // ---- agent command lists (ADR 0009 §3) ----

  const GENERIC_KEY = "_generic_";

  function defaultAgentCommands() {
    return {
      [GENERIC_KEY]: { allow: [], deny: [] },
    };
  }

  function emptyAgentEntry() {
    return { allow: [], deny: [] };
  }

  async function readAgentCommands() {
    const ws = await readWorkspace();
    if (!ws || !ws.agentCommands || typeof ws.agentCommands !== "object") {
      return defaultAgentCommands();
    }
    const ac = ws.agentCommands;
    const out = {};
    for (const [k, v] of Object.entries(ac)) {
      if (v && typeof v === "object") {
        out[k] = {
          allow: Array.isArray(v.allow) ? v.allow : [],
          deny: Array.isArray(v.deny) ? v.deny : [],
        };
      }
    }
    return out;
  }

  async function writeAgentCommands(ac) {
    return updateWorkspace({ agentCommands: ac });
  }

  async function getAgentCommands(agentName) {
    const ac = await readAgentCommands();
    const generic = ac[GENERIC_KEY] || emptyAgentEntry();
    const named = ac[agentName] || null;
    if (!named) return generic;
    return {
      allow: [...(generic.allow || []), ...(named.allow || [])],
      deny: [...(generic.deny || []), ...(named.deny || [])],
    };
  }

  async function addToAgentCommands(agentName, list, command) {
    if (!command || typeof command !== "string") return;
    const ac = await readAgentCommands();
    const key = agentName || GENERIC_KEY;
    if (!ac[key]) ac[key] = emptyAgentEntry();
    const target = list === "allow" ? "allow" : "deny";
    if (!ac[key][target].includes(command)) {
      ac[key][target] = [...ac[key][target], command];
      await writeAgentCommands(ac);
    }
  }

  // ---- threads ----

  // Per-thread serialisation chain for meta.json writes. Without this, two
  // concurrent async operations (e.g. the loop's appendMessage bumping
  // updatedAt while agent_stop writes status=stopped) can both read the
  // same stale meta, then write back different patches, and one silently
  // wins — classic lost-update. We chain each writeThreadMeta behind the
  // previous one for that thread, the same pattern messages-log.mjs uses
  // for messages.jsonl. Reads are intentionally NOT chained: they are
  // always reads of the current committed state and a slightly stale read
  // is acceptable. Only writes must be serialised.
  const metaChains = new Map(); // threadId -> Promise<void>

  function threadMetaFile(threadId) {
    return join(threadsDir, `${threadId}.meta.json`);
  }
  function threadTranscriptFile(threadId) {
    return join(threadsDir, `${threadId}.jsonl`);
  }

  async function writeThreadMeta(threadId, meta) {
    const previous = metaChains.get(threadId) || Promise.resolve();
    const next = previous.then(() => doWriteThreadMeta(threadId, meta));
    // Swallow errors in the chain link so a single failure does not poison
    // every subsequent write. Callers still see the rejection via `next`.
    metaChains.set(threadId, next.catch(() => {}));
    return next;
  }

  async function doWriteThreadMeta(threadId, meta) {
    await ensureDirs();
    await writeFile(threadMetaFile(threadId), JSON.stringify(meta, null, 2), "utf8");
  }

  async function readThreadMeta(threadId) {
    try {
      const raw = await readFile(threadMetaFile(threadId), "utf8");
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  async function appendThreadMessage(threadId, message) {
    await ensureDirs();
    const line = JSON.stringify({ ts: Date.now(), ...message }) + "\n";
    await appendFile(threadTranscriptFile(threadId), line, "utf8");
  }

  async function readThreadMessages(threadId) {
    try {
      const raw = await readFile(threadTranscriptFile(threadId), "utf8");
      return raw.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
  }

  /**
   * List threads in THIS workspace only. For cross-workspace listing
   * the caller must aggregate across multiple workspace stores.
   */
  async function listThreads() {
    await ensureDirs();
    const out = [];
    let entries;
    try {
      entries = await readdir(threadsDir);
    } catch {
      return out;
    }
    for (const name of entries) {
      if (!name.endsWith(".meta.json")) continue;
      const id = name.slice(0, -".meta.json".length);
      const meta = await readThreadMeta(id);
      if (meta) out.push(meta);
    }
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return out;
  }

  return {
    root,
    cwd: absCwd,
    // workspace
    readWorkspace,
    writeWorkspace,
    ensureWorkspace,
    updateWorkspace,
    // agent commands
    readAgentCommands,
    getAgentCommands,
    addToAgentCommands,
    // threads
    writeThreadMeta,
    readThreadMeta,
    appendThreadMessage,
    readThreadMessages,
    listThreads,
  };
}
