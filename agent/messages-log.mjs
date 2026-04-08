// Durable message log for the event bus.
//
// This module owns the append-only `messages.jsonl` file and provides
// functions to append messages, read them back, and generate monotonic IDs.
// It is the single source of truth for messages across process restarts and
// multiple components (MCP server, hooks, external scripts).
//
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveProjectDir } from "./data-dir.mjs";

const MESSAGES_FILE = "messages.jsonl";

// Per-workspace serialisation chain for appendMessage. Without this, two
// concurrent publish() calls can both await nextMessageId(), both read the
// same last id, and both assign the same new id. Node is single-threaded
// but async reads interleave. We keep one promise per cwd and chain each
// new append behind the previous one. Serialisation is per-workspace so
// parallel workspaces do not block each other.
const appendChains = new Map(); // cwd -> Promise<void>

/**
 * Generate the next monotonic message ID.
 * Reads the last line of messages.jsonl to find the highest existing ID,
 * increments it, and returns the new ID in format `m000001`, `m000042`, etc.
 * If the file is empty or missing, starts at `m000001`.
 * @param {string} cwd - absolute path to the project root
 * @returns {Promise<string>}
 */
async function nextMessageId(cwd) {
  const root = resolveProjectDir(cwd);
  const filePath = join(root, MESSAGES_FILE);

  try {
    const raw = await readFile(filePath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) return "m000001";

    const lastLine = lines[lines.length - 1];
    const lastMsg = JSON.parse(lastLine);
    if (!lastMsg.id || !lastMsg.id.startsWith("m")) {
      return "m000001"; // corrupt or missing id, reset
    }

    const num = parseInt(lastMsg.id.slice(1), 10);
    return `m${(num + 1).toString().padStart(6, "0")}`;
  } catch (err) {
    if (err.code === "ENOENT") return "m000001";
    // If the file is corrupt or unreadable, start fresh
    return "m000001";
  }
}

/**
 * Append a message to the durable log.
 * Fills in `id` and `at`, then appends a single JSON line to
 * `<cwd>/.claude/agnz/messages.jsonl`. Creates the file and its parent
 * directory if missing. The `to` field may be a string or an array of
 * strings and is passed through unchanged.
 * @param {string} cwd - absolute path to the project root
 * @param {Object} partial - message without id and at
 * @returns {Promise<Object>} full message object with id and at
 */
export async function appendMessage(cwd, partial) {
  if (!cwd || !partial) throw new Error("appendMessage: cwd and partial are required");

  // Chain behind any in-flight append for this workspace so id allocation
  // and file append happen atomically from the caller's perspective.
  const previous = appendChains.get(cwd) || Promise.resolve();
  const next = previous.then(() => doAppend(cwd, partial));
  // Swallow errors in the chain link so a single failure does not poison
  // every subsequent append. Callers still see the rejection via `next`.
  appendChains.set(cwd, next.catch(() => {}));
  return next;
}

async function doAppend(cwd, partial) {
  const root = resolveProjectDir(cwd);
  await mkdir(root, { recursive: true });

  const id = await nextMessageId(cwd);
  const at = new Date().toISOString();
  const message = { ...partial, id, at };

  const filePath = join(root, MESSAGES_FILE);
  const line = JSON.stringify(message) + "\n";
  await appendFile(filePath, line, "utf8");

  return message;
}

/**
 * Read messages with id > cursorId.
 * If cursorId is null/undefined/empty, returns all messages.
 * Returns an array; if the file doesn't exist, returns [].
 * Malformed lines are skipped silently.
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
      .filter((msg) => msg !== null && (cursorId === undefined || cursorId === null || cursorId === "" || msg.id > cursorId));
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
