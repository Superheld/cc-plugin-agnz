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
import { join, resolve } from "node:path";
import { resolveProjectDir } from "./data-dir.mjs";

/**
 * Create a workspace store for a specific project cwd.
 * @param {string} cwd — absolute path to the project root
 */
export function createWorkspaceStore(cwd) {
  if (!cwd) throw new Error("workspace-store: cwd is required");
  const root = resolveProjectDir(resolve(cwd));
  const threadsDir = join(root, "threads");

  async function ensureDirs() {
    await mkdir(threadsDir, { recursive: true });
  }

  // ---- threads ----

  function threadMetaFile(threadId) {
    return join(threadsDir, `${threadId}.meta.json`);
  }
  function threadTranscriptFile(threadId) {
    return join(threadsDir, `${threadId}.jsonl`);
  }

  async function writeThreadMeta(threadId, meta) {
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
    cwd: resolve(cwd),
    writeThreadMeta,
    readThreadMeta,
    appendThreadMessage,
    readThreadMessages,
    listThreads,
  };
}
