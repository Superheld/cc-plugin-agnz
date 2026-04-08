// Memory: three scopes with very different semantics.
//
//   thread  — conversation history (messages), append-only, auto-managed
//             by the agent loop. Stored as JSONL so partial crashes still
//             leave a readable transcript.
//
//   project — free-form markdown notes keyed by an absolute project path.
//             Persistent across threads that share the same cwd. Both the
//             agent (via a memory tool, later) and the user can edit.
//
//   global  — free-form markdown notes shared across all projects. For
//             user-wide preferences the agent should remember.
//
// This module is pure persistence; higher layers decide when to read/write.

import { mkdir, readFile, writeFile, appendFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

/**
 * Deterministic, filesystem-safe handle for a project path.
 * Uses sha1 of the absolute real path; collisions are irrelevant here.
 */
export function projectKey(absPath) {
  const normalized = resolve(absPath);
  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

export function createMemoryStore({ dataDir }) {
  if (!dataDir) throw new Error("memory: dataDir is required");
  const root = resolve(dataDir);
  const threadsDir = join(root, "threads");
  const projectDir = join(root, "memory", "project");
  const globalFile = join(root, "memory", "global.md");

  async function ensureDirs() {
    await mkdir(threadsDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await mkdir(dirname(globalFile), { recursive: true });
  }

  // ---- thread ----

  function threadFile(threadId) {
    return join(threadsDir, `${threadId}.jsonl`);
  }
  function threadMetaFile(threadId) {
    return join(threadsDir, `${threadId}.meta.json`);
  }

  async function appendThreadMessage(threadId, message) {
    await ensureDirs();
    const line = JSON.stringify({ ts: Date.now(), ...message }) + "\n";
    await appendFile(threadFile(threadId), line, "utf8");
  }

  async function readThreadMessages(threadId) {
    try {
      const raw = await readFile(threadFile(threadId), "utf8");
      return raw
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l));
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
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

  // ---- project ----

  function projectFile(projectPath) {
    return join(projectDir, `${projectKey(projectPath)}.md`);
  }

  async function readProjectMemory(projectPath) {
    try {
      return await readFile(projectFile(projectPath), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return "";
      throw err;
    }
  }

  async function writeProjectMemory(projectPath, content) {
    await ensureDirs();
    await writeFile(projectFile(projectPath), content, "utf8");
  }

  // ---- global ----

  async function readGlobalMemory() {
    try {
      return await readFile(globalFile, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return "";
      throw err;
    }
  }

  async function writeGlobalMemory(content) {
    await ensureDirs();
    await writeFile(globalFile, content, "utf8");
  }

  // Uniform API for the MCP memory_read/memory_write tools.
  async function read(scope, key) {
    if (scope === "global") return readGlobalMemory();
    if (scope === "project") {
      if (!key) throw new Error("memory: project scope requires a path key");
      return readProjectMemory(key);
    }
    if (scope === "thread") {
      if (!key) throw new Error("memory: thread scope requires a thread id");
      const msgs = await readThreadMessages(key);
      return msgs.map((m) => `[${m.role}] ${m.content ?? ""}`).join("\n");
    }
    throw new Error(`memory: unknown scope: ${scope}`);
  }

  async function write(scope, key, content) {
    if (scope === "global") return writeGlobalMemory(content);
    if (scope === "project") {
      if (!key) throw new Error("memory: project scope requires a path key");
      return writeProjectMemory(key, content);
    }
    throw new Error(`memory: scope '${scope}' is not directly writable`);
  }

  return {
    // thread
    appendThreadMessage,
    readThreadMessages,
    writeThreadMeta,
    readThreadMeta,
    listThreads,
    // project
    readProjectMemory,
    writeProjectMemory,
    // global
    readGlobalMemory,
    writeGlobalMemory,
    // uniform
    read,
    write,
  };
}
