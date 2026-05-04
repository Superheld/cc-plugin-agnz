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
// `lib/` so that the plugin's hook scripts keep working even if the
// surrounding module layout is refactored.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";

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
 * null if the cwd is missing, not absolute, or the workspace does
 * not exist — all "fast no-op" signals for the hook.
 *
 * Claude Code always passes an absolute cwd, but we refuse anything
 * that is not, both as a cheap sanity check and as defense-in-depth
 * against a malformed / adversarial hook envelope: `resolve()` on a
 * relative path would mix in whatever the hook process's cwd happens
 * to be at invocation time, which is not a path we want to touch.
 */
export function resolveWorkspace(cwd) {
  if (!cwd || typeof cwd !== "string") return null;
  const abs = resolve(cwd);
  if (abs !== cwd) return null; // reject relative inputs
  const ws = resolve(abs, ".claude", "agnz");
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
 * Persist the parent cursor atomically via tmp-file + rename. The rename
 * is an atomic operation on POSIX so a crash mid-write cannot leave a
 * half-written cursor file behind. Callers must ONLY invoke this AFTER
 * stdout has been flushed to Claude — see flushStdoutThen() — otherwise
 * the cursor would advance past messages that never made it into the
 * parent's context (silent data loss).
 */
export function writeParentCursor(ws, cursor) {
  const dir = resolve(ws, "cursors");
  mkdirSync(dir, { recursive: true });
  const finalPath = resolve(dir, "parent.json");
  const tmpPath = resolve(dir, `parent.json.tmp.${process.pid}`);
  writeFileSync(tmpPath, JSON.stringify({ cursor }), "utf8");
  renameSync(tmpPath, finalPath);
}

/**
 * Write a string to stdout, then invoke `then` only after Node reports
 * the write has drained. Guards against the "cursor advanced but stdout
 * never reached Claude" race: the write callback fires after the OS has
 * accepted the bytes, so we're safe to mark the messages as delivered.
 *
 * If Node reports `false` from the initial write (kernel buffer full),
 * we wait for the 'drain' event before proceeding.
 */
export function flushStdoutThen(text, then) {
  const ok = process.stdout.write(text, (err) => {
    if (err) {
      // Write failed — do NOT advance the cursor; the messages will be
      // redelivered next turn. Surface the error so the outer hook can
      // decide how loud to be.
      then(err);
      return;
    }
    then(null);
  });
  if (!ok) {
    // Buffer was full; wait for drain so 'then' isn't called prematurely
    // by a sync exit.
    process.stdout.once("drain", () => {});
  }
}

/**
 * Read unread messages addressed to the parent. Returns an array
 * ordered by id ascending. Missing file → [].
 *
 * Cursor comparison is lexicographic (`msg.id > cursor`). This is
 * correct ONLY because lib/messages-log.mjs allocates ids with a
 * fixed-width zero-padded counter (m000001, m000002, …) — lexical
 * order matches numeric order exactly. If the id format ever
 * changes (wider counter, epoch-millis prefix, uuid), this
 * comparison must change too.
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

// Max number of messages to render into Claude's context in a single
// injection. A burst of 500 unread messages would otherwise inject
// ~100 KB after per-message truncation. When the cap kicks in we show
// the MOST recent N (they are most actionable) and add a footer line
// noting how many were elided — the rest stay in messages.jsonl.
const MAX_MESSAGES_IN_INJECTION = 20;

// Per-message text truncation cap. Prevents a single oversized message
// from blowing out the context even when the count is within bounds.
// 2000 chars ≈ ~400 tokens — enough for a full agent summary.
const MAX_TEXT_LENGTH = 2000;

/**
 * Format a message list for stdout injection. Applies two caps:
 *   - per-message text truncation (MAX_TEXT_LENGTH)
 *   - total message count (MAX_MESSAGES_IN_INJECTION)
 * When the count cap trims the list, the MOST recent N are kept and
 * an elision footer line is emitted.
 */
export function formatMessages(messages) {
  const total = messages.length;
  const shown =
    total > MAX_MESSAGES_IN_INJECTION
      ? messages.slice(total - MAX_MESSAGES_IN_INJECTION)
      : messages;
  const elided = total - shown.length;

  const header = `[agnz] ${total} new message(s) since last interaction:`;
  const lines = shown.map((m) => {
    const text = typeof m.text === "string" ? m.text : "";
    const short =
      text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH - 1)}…` : text;
    return `- ${m.id} ${m.from || "?"} ${m.kind || "?"}: ${short}`;
  });
  const out = [header, ...lines];
  if (elided > 0) {
    out.push(
      `… ${elided} older message(s) elided; see <cwd>/.claude/agnz/messages.jsonl for the full log.`,
    );
  }
  return out.join("\n");
}

function addressesParent(to) {
  if (typeof to === "string") return to === "parent";
  if (Array.isArray(to)) return to.includes("parent");
  return false;
}

/**
 * Read all non-stopped thread metas from the workspace.
 * Returns an array of objects with id, name, status, agent, and updatedAt.
 */
export function readThreadMetas(wsDir) {
  const threadsDir = join(wsDir, "threads");
  try {
    const files = readdirSync(threadsDir).filter(f => f.endsWith(".meta.json"));
    return files.flatMap(f => {
      try {
        const meta = JSON.parse(readFileSync(join(threadsDir, f), "utf8"));
        if (meta.status === "stopped") return [];
        return [{
          id: meta.id,
          name: meta.name || null,
          status: meta.status,
          agent: meta.agentDef?.name || null,
          updatedAt: meta.updatedAt || null,
        }];
      } catch { return []; }
    });
  } catch { return []; }
}

/**
 * Format a list of threads into a compact string.
 * Example: "hook-visibility running, researcher idle"
 */
export function formatThreads(threads) {
  if (!threads || threads.length === 0) return null;
  const pairs = threads.map(t => `${t.name || "?"} ${t.status}`);
  return pairs.join(", ");
}
