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

import { mkdir, readFile, appendFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveProjectDir } from "./data-dir.mjs";
import { atomicWriteFile } from "./atomic-write.mjs";
import { withProcLock } from "./proc-lock.mjs";

/**
 * Current schema version for workspace.json. Bump when the shape
 * changes and provide a migration path from the previous version.
 */
export const WORKSPACE_SCHEMA_VERSION = 2;

/**
 * Sentinel a mutateThreadMeta patchFn can return to abort the mutation without
 * writing anything at all — not even the updatedAt bump. Distinct from a falsy
 * return (which still writes, bumping updatedAt only). The runner's admission
 * claim needs this: a runner that loses the race must touch nothing (no
 * runnerPid clobber, no meta churn) before exiting.
 */
export const SKIP_MUTATION = Symbol("agnz.skipMutation");

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
  // Pure workspace STATE (ADR 0017): the parent's delivery position and,
  // later, ADR 0004 board fields. Config lives in config.json; `name` and
  // `cwd` are gone — both derivable from the file's own location, and a
  // stored cwd was observed lying after a project move.

  function defaultWorkspace() {
    return {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      // Parent's read position into messages.jsonl + the thread-set
      // fingerprint for injection dedup. Written by the CC hooks (after
      // stdout drain), mirroring how each sub-agent keeps its inboxCursor
      // in its own thread meta.
      parent: { cursor: null, offset: 0, threadFingerprint: null },
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
    await atomicWriteFile(workspaceFile, JSON.stringify(next, null, 2));
    return next;
  }

  /**
   * Load workspace.json, creating a default one if missing. This is
   * the entry point used by agent_start — the first thread in a new
   * project automatically initialises the workspace.
   */
  async function ensureWorkspace() {
    const existing = await readWorkspace();
    if (!existing) return writeWorkspace(defaultWorkspace());
    if ((existing.schemaVersion || 1) < WORKSPACE_SCHEMA_VERSION) {
      // v1 → v2: keep createdAt, drop name/cwd/modelProfileMappings (config
      // now lives in config.json — resolution fails loudly there until the
      // user re-runs setup, per ADR 0017's no-migration decision).
      return writeWorkspace({
        ...defaultWorkspace(),
        createdAt: existing.createdAt ?? Date.now(),
      });
    }
    return existing;
  }

  async function updateWorkspace(patch) {
    // Serialise the read-modify-write across processes so concurrent updates
    // don't clobber (CLI + runners both touch workspace.json).
    await ensureDirs();
    return withProcLock(workspaceFile + ".lock", async () => {
      const current = (await readWorkspace()) || defaultWorkspace();
      return writeWorkspace({ ...current, ...patch });
    });
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
    await atomicWriteFile(threadMetaFile(threadId), JSON.stringify(meta, null, 2));
  }

  /**
   * Permanently delete every file belonging to a thread. Matches by the
   * `<id>.` filename prefix rather than a fixed list, so companions added
   * later (trace today, anything tomorrow) can never be left behind as
   * orphans the user does not know about. Returns the deleted names.
   */
  async function deleteThreadFiles(threadId) {
    await ensureDirs();
    const names = (await readdir(threadsDir)).filter((n) => n.startsWith(`${threadId}.`));
    for (const n of names) {
      await rm(join(threadsDir, n), { force: true });
    }
    metaChains.delete(threadId);
    return names;
  }

  /**
   * Read-modify-write a thread's meta inside ONE metaChains link, so the
   * read sees the latest committed state and the write can't be clobbered
   * by a concurrent mutation. `patchFn(current)` returns a partial patch to
   * merge (or a falsy value for "no change beyond the updatedAt bump").
   * This is the race-safe path; plain updateThread now routes through here.
   */
  async function mutateThreadMeta(threadId, patchFn) {
    const previous = metaChains.get(threadId) || Promise.resolve();
    const next = previous.then(() => doMutateThreadMeta(threadId, patchFn));
    metaChains.set(threadId, next.catch(() => {}));
    return next;
  }

  async function doMutateThreadMeta(threadId, patchFn) {
    await ensureDirs();
    const file = threadMetaFile(threadId);
    // Cross-process lock: the in-process metaChains mutex (above) handles
    // same-process serialisation; this guards the runner vs. a CLI stop/
    // interrupt vs. another runner all mutating the same meta from different
    // processes (would otherwise lose an update across the read-modify-write).
    return withProcLock(file + ".lock", async () => {
      const current = await readThreadMeta(threadId);
      if (!current) throw new Error(`workspace-store: no such thread meta: ${threadId}`);
      const patch = await patchFn(current);
      // A patchFn that declines the mutation (lost the admission race) returns
      // the sentinel — write nothing and hand back the unchanged committed meta.
      if (patch === SKIP_MUTATION) return current;
      const merged = { ...current, ...(patch || {}), updatedAt: Date.now() };
      await atomicWriteFile(file, JSON.stringify(merged, null, 2));
      return merged;
    });
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

  // ---- model profile mappings (ADR 0003 §4a) ----

  /**
   * Map a model identifier (from agent def) to a profile name.
   * This allows agents to specify which profile to use without knowing
   * the endpoint details. The profile carries the actual model string
   * (whatever the endpoint is currently serving).
   *
   * Example workspace.json:
   * {
   *   "modelProfileMappings": {
   *     "opus": "lmstudio-large",      // agent with model: opus → profile lmstudio-large
   *     "sonnet": "lmstudio-devstral", // agent with model: sonnet → profile lmstudio-devstral
   *     "_default": "lmstudio-default" // fallback profile
   *   }
   * }
   */
  // ---- system prompt snapshot (ADR 0017) ----
  //
  // The frozen prompt prefix (ADR 0012 phase 1) used to live inside
  // meta.json, where it was ~75 % of every meta rewrite despite never
  // changing. It is now its own write-once file, swept by
  // deleteThreadFiles via the shared `<id>.` prefix.

  function threadSystemPromptFile(threadId) {
    return join(threadsDir, `${threadId}.system.txt`);
  }

  async function writeSystemPrompt(threadId, text) {
    await ensureDirs();
    await atomicWriteFile(threadSystemPromptFile(threadId), text);
  }

  async function readSystemPrompt(threadId) {
    try {
      return await readFile(threadSystemPromptFile(threadId), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  return {
    root,
    cwd: absCwd,
    // workspace
    readWorkspace,
    writeWorkspace,
    ensureWorkspace,
    updateWorkspace,
    // system prompt snapshot
    writeSystemPrompt,
    readSystemPrompt,
    // threads
    writeThreadMeta,
    mutateThreadMeta,
    readThreadMeta,
    deleteThreadFiles,
    appendThreadMessage,
    readThreadMessages,
    listThreads,
  };
}
