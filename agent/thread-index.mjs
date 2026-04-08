// A tiny cross-workspace index mapping thread_id → cwd.
//
// Why this exists: MCP tools like agent_send(thread_id, ...) take only
// a thread id. With ADR 0001 per-project workspaces, the thread's
// actual files live under the cwd the thread was started in. We need
// some way to resolve an id back to its cwd without scanning every
// project on the machine.
//
// The index lives in the user-wide data dir as a single JSON file.
// It is updated on create and on explicit forget/stop. Lost entries
// are not catastrophic — the caller can always re-create the thread
// from a known cwd — but they make tool calls that use raw ids fail
// with a friendly "no such thread" error.
//
// Format:
//   { "<thread-id>": { "cwd": "<abs-path>", "createdAt": <ms> }, ... }

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveUserDir } from "./data-dir.mjs";

function indexFile() {
  return join(resolveUserDir(), "thread-index.json");
}

async function readIndex() {
  try {
    const raw = await readFile(indexFile(), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

async function writeIndex(index) {
  const file = indexFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(index, null, 2), "utf8");
}

/** Register a thread's cwd at creation time. */
export async function registerThread(threadId, cwd) {
  const index = await readIndex();
  index[threadId] = { cwd: resolve(cwd), createdAt: Date.now() };
  await writeIndex(index);
}

/** Look up the cwd for a thread id. Returns null if unknown. */
export async function lookupThreadCwd(threadId) {
  const index = await readIndex();
  return index[threadId]?.cwd || null;
}

/** Drop a thread from the index. Idempotent. */
export async function forgetThread(threadId) {
  const index = await readIndex();
  if (index[threadId]) {
    delete index[threadId];
    await writeIndex(index);
  }
}

/** List all known thread ids with their cwds. */
export async function listIndex() {
  return readIndex();
}
