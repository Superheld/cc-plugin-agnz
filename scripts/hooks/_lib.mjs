// Shared helpers for the agnz Claude Code hooks.
//
// Hooks run on EVERY CC session in the user install — they are global,
// not scoped to projects that have agnz. That means every helper here
// must be a fast no-op when the current cwd is not an agnz workspace,
// and must NEVER throw out of the hook (throwing would block Claude's
// prompt flow). All public functions return plain data; the callers
// are responsible for writing to stdout / stderr.
//
// Self-contained by design: these hooks must not import anything from
// `agent/` so that the plugin's hook scripts keep working even if the
// surrounding module layout is refactored.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Read all of stdin synchronously into a string.
 * `readFileSync(0, ...)` reads from file descriptor 0 (= stdin) and
 * blocks until EOF. This is the only reliable way to drain stdin from
 * a short-lived hook script — the stream-reading API (stdin.read())
 * returns null if called before the data event has fired.
 */
export function readStdinSync() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * Parse hook input. CC passes a JSON object on stdin. Returns the
 * parsed object or null on any failure — the caller decides how to
 * handle "no valid input".
 */
export function parseHookInput(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Resolve the agnz workspace dir for a given project cwd. Returns
 * null if the cwd is missing or the workspace does not exist — both
 * are "fast no-op" signals for the hook.
 */
export function resolveWorkspace(cwd) {
  if (!cwd || typeof cwd !== "string") return null;
  const ws = resolve(cwd, ".claude", "agnz");
  if (!existsSync(ws)) return null;
  return ws;
}

/**
 * Read the parent cursor file. Missing or malformed → null.
 */
export function readParentCursor(ws) {
  const path = resolve(ws, "cursors", "parent.json");
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return typeof data?.cursor === "string" ? data.cursor : null;
  } catch {
    return null;
  }
}

/**
 * Persist the parent cursor. Creates the cursors/ dir if missing.
 */
export function writeParentCursor(ws, cursor) {
  const dir = resolve(ws, "cursors");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "parent.json"), JSON.stringify({ cursor }), "utf8");
}

/**
 * Read unread messages addressed to the parent. Returns an array
 * ordered by id ascending. Missing file → [].
 */
export function readUnreadForParent(ws, cursor) {
  const path = resolve(ws, "messages.jsonl");
  if (!existsSync(path)) return [];
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // skip malformed lines
    }
    if (!msg || !msg.id) continue;
    if (!addressesParent(msg.to)) continue;
    if (cursor && !(msg.id > cursor)) continue;
    out.push(msg);
  }
  return out;
}

/**
 * Read workspace.json. Missing or malformed → null.
 */
export function readWorkspaceFile(ws) {
  const path = resolve(ws, "workspace.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Format a message list for stdout injection. Truncates long text to
 * 200 chars (with ellipsis) so a single oversized message cannot blow
 * out the parent's context.
 */
export function formatMessages(messages) {
  const header = `[agnz] ${messages.length} new message(s) since last interaction:`;
  const lines = messages.map((m) => {
    const text = typeof m.text === "string" ? m.text : "";
    const short = text.length > 200 ? `${text.slice(0, 199)}…` : text;
    return `- ${m.id} ${m.from || "?"} ${m.kind || "?"}: ${short}`;
  });
  return [header, ...lines].join("\n");
}

function addressesParent(to) {
  if (typeof to === "string") return to === "parent";
  if (Array.isArray(to)) return to.includes("parent");
  return false;
}
