// Durable message log for the event bus.
//
// This module owns the append-only `messages.jsonl` file and provides
// functions to append messages, read them back, and generate monotonic IDs.
// It is the single source of truth for messages across process restarts and
// multiple components (MCP server / CLI runners, hooks, external scripts).
//
// Id allocation is safe against TWO kinds of concurrency:
//   - within one process: the per-workspace appendChains promise mutex.
//   - across processes (multiple CLI runners writing the same log): a
//     mkdir-based lock dir, since mkdir is atomic cross-process.
// The id is derived from the highest VALID id in the file's tail — a
// truncated or foreign last line never resets the sequence (which would
// collide ids and make the parent silently miss mail).

import { mkdir, readFile, appendFile, open } from "node:fs/promises";
import { join } from "node:path";
import { resolveProjectDir } from "./data-dir.mjs";
import { withProcLock } from "./proc-lock.mjs";

const MESSAGES_FILE = "messages.jsonl";
const LOCK_DIR = "messages.lock";
const TAIL_BYTES = 64 * 1024; // read only this much of the tail for the max id
const ID_RE = /^m\d{6,}$/;

// Per-workspace serialisation chain for appendMessage — keeps same-process
// appends from spinning on the cross-process lock.
const appendChains = new Map(); // cwd -> Promise<void>

function formatId(num) {
  return `m${num.toString().padStart(6, "0")}`;
}

/**
 * Highest existing message id (as a number), read from the file's tail so
 * cost is O(1) in the log size. Scans backward for the last line that parses
 * to a valid id; NEVER resets to 0 just because the final line is corrupt.
 * Falls back to a full scan only if the tail window held no valid id.
 * Returns 0 for a missing or genuinely empty/id-less file.
 */
async function maxMessageId(filePath) {
  let fh;
  try {
    fh = await open(filePath, "r");
  } catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
  try {
    const { size } = await fh.stat();
    if (size === 0) return 0;

    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    // If we didn't start at a line boundary, drop the partial leading line.
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }

    const fromTail = scanBackForId(text);
    if (fromTail !== null) return fromTail;

    // Tail window had no valid id but the file is larger — full scan rather
    // than risk resetting the sequence.
    if (start > 0) {
      const full = await readFile(filePath, "utf8");
      const fromFull = scanBackForId(full);
      if (fromFull !== null) return fromFull;
    }
    return 0;
  } finally {
    await fh.close();
  }
}

function scanBackForId(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].length === 0) continue;
    try {
      const msg = JSON.parse(lines[i]);
      if (typeof msg.id === "string" && ID_RE.test(msg.id)) {
        return parseInt(msg.id.slice(1), 10);
      }
    } catch {
      // partial/foreign line — keep scanning backward
    }
  }
  return null;
}

/**
 * Append a message to the durable log. Fills in `id` and `at`, then appends a
 * single JSON line. Creates the file and parent dir if missing. `to` may be a
 * string or array of strings and is passed through unchanged.
 * @param {string} cwd - absolute path to the project root
 * @param {Object} partial - message without id and at
 * @returns {Promise<Object>} full message object with id and at
 */
export async function appendMessage(cwd, partial) {
  if (!cwd || !partial) throw new Error("appendMessage: cwd and partial are required");

  // Chain behind any in-flight append for this workspace, then take the
  // cross-process lock inside doAppend.
  const previous = appendChains.get(cwd) || Promise.resolve();
  const next = previous.then(() => doAppend(cwd, partial));
  appendChains.set(cwd, next.catch(() => {}));
  return next;
}

async function doAppend(cwd, partial) {
  const root = resolveProjectDir(cwd);
  await mkdir(root, { recursive: true });
  const filePath = join(root, MESSAGES_FILE);

  return withProcLock(join(root, LOCK_DIR), async () => {
    const num = await maxMessageId(filePath);
    const id = formatId(num + 1);
    const at = new Date().toISOString();
    const message = { ...partial, id, at };
    // appendFile opens with O_APPEND, so the line write itself is atomic.
    await appendFile(filePath, JSON.stringify(message) + "\n", "utf8");
    return message;
  });
}

/**
 * Read messages with id > cursorId. If cursorId is null/undefined/empty,
 * returns all messages. Returns []; if the file doesn't exist. Malformed
 * lines are skipped silently.
 * @param {string} cwd - absolute path to the project root
 * @param {string|null|undefined} cursorId - last seen message id
 * @returns {Promise<Array>}
 */
export async function readMessagesSince(cwd, cursorId) {
  const root = resolveProjectDir(cwd);
  const filePath = join(root, MESSAGES_FILE);

  try {
    const raw = await readFile(filePath, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null; // skip malformed lines
        }
      })
      .filter(
        (msg) =>
          msg !== null &&
          (cursorId === undefined || cursorId === null || cursorId === "" || msg.id > cursorId),
      );
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err; // other errors (perm, etc.) should propagate
  }
}

/**
 * Convenience: read all messages in the file.
 * @param {string} cwd - absolute path to the project root
 * @returns {Promise<Array>}
 */
export async function readAllMessages(cwd) {
  return readMessagesSince(cwd, null);
}
