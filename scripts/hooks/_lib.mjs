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

// No per-message truncation — deliver full content. The message count
// cap (MAX_MESSAGES_IN_INJECTION) keeps total injection size bounded.
const MAX_TEXT_LENGTH = Infinity;

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
 * Fold a thread's trace.jsonl into a tiny spend summary: turns and total
 * tokens (ADR 0011 §3). Inlined here rather than importing
 * lib/trace-stats.mjs to keep the hooks self-contained per the convention
 * at the top of this file. Missing/garbled trace → { turns: 0, tokens: 0 }.
 */
export function readThreadSpend(wsDir, threadId) {
  const path = join(wsDir, "threads", `${threadId}.trace.jsonl`);
  if (!existsSync(path)) return { turns: 0, tokens: 0 };
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { turns: 0, tokens: 0 };
  }
  let turns = 0;
  let tokens = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "thread_start" || e.type === "turn_start") turns += 1;
    else if (e.type === "llm_call" && e.usage && typeof e.usage.total === "number") {
      tokens += e.usage.total;
    }
  }
  return { turns, tokens };
}

/**
 * Single source of truth for "which threads does the lead see". A thread
 * stays listed as long as it is *open* — idle counts as open (finished but
 * resumable, like a paused conversation). `stopped` is the archive state:
 * the lead closes a thread it no longer needs with `agnz stop`, which hides
 * it here while keeping its transcript on disk. So the list is pruned by
 * deliberate cleanup, not by status decay.
 */
export function isListedThread(status) {
  return status !== "stopped";
}

/**
 * Read all listed (non-stopped) thread metas from the workspace.
 * Returns an array of objects with id, name, status, agent, updatedAt,
 * and a trace-derived spend ({ turns, tokens }).
 */
export function readThreadMetas(wsDir) {
  const threadsDir = join(wsDir, "threads");
  try {
    const files = readdirSync(threadsDir).filter(f => f.endsWith(".meta.json"));
    return files.flatMap(f => {
      try {
        const meta = JSON.parse(readFileSync(join(threadsDir, f), "utf8"));
        if (!isListedThread(meta.status)) return [];
        return [{
          id: meta.id,
          name: meta.name || null,
          status: meta.status,
          agent: meta.agentDef?.name || null,
          // Rolling summary (loop-maintained) → description → agent-def role.
          // Lets the parent see reusable context per thread (ADR 0007).
          summary:
            meta.summary ||
            meta.description ||
            (meta.agentDef?.description ? String(meta.agentDef.description).split("\n")[0] : null),
          updatedAt: meta.updatedAt || null,
          spend: readThreadSpend(wsDir, meta.id),
        }];
      } catch { return []; }
    });
  } catch { return []; }
}

/** Compact token count with thousands separators (1234 -> "1,234"). */
function formatTokens(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Format a list of threads into a compact, reuse-informative string. Each
 * thread shows its name, status, and a short rolling summary so the parent
 * can decide to resume (`send <name>`) instead of spawning a new one.
 * Example: "researcher (idle): summarised request logging; dev (running)"
 */
export function formatThreads(threads) {
  if (!threads || threads.length === 0) return null;
  return threads
    .map((t) => {
      const s = t.summary ? `: ${String(t.summary).slice(0, 70)}` : "";
      return `${t.name || "?"} (${t.status})${s}`;
    })
    .join("; ");
}

// Sort priority for the thread block: live work first, then paused-for-input,
// then idle (finished but resumable), errors last. Within a status group the
// most-recently-touched thread comes first, so stale threads sink toward the
// bottom where they read as "cleanup candidates" (N4).
const STATUS_ORDER = { running: 0, awaiting_input: 1, idle: 2, error: 3 };

// Above this many idle threads the block appends one line nudging the lead to
// close finished ones (N2). Below it the list stays nag-free — the per-thread
// age tag alone signals staleness (N3). Set high so the hint only fires on
// real clutter, honouring the context-diet goal.
const IDLE_NUDGE_THRESHOLD = 5;

// Timestamps in thread meta are epoch millis (numbers), but ISO strings show
// up in tests and older metas — accept both. Returns ms or null.
function parseTs(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Date.parse(v);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

/** Human-compact age from a timestamp: "now" / "5m" / "3h" / "2d". */
function formatAge(updatedAt, now) {
  const then = parseTs(updatedAt);
  if (then === null) return "";
  const secs = Math.max(0, Math.floor((now - then) / 1000));
  if (secs < 60) return "now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Format threads as a multi-line block with short-id, status, age, and the
 * trace-derived spend (ADR 0007 §1 layer 2 + ADR 0011 §3). Threads stay
 * listed until the lead closes them (`agnz stop`), so the header is honest
 * about how many are *open* vs merely *idle* (finished, resumable), and a
 * per-thread age tag surfaces staleness without nagging. Example:
 *
 *   threads (2 open · 1 idle):
 *     dev:1a2b3c4d — running · now · 5 turns · 1,234 tok
 *     reviewer:9f8e7d6c — idle · 2h · 12 turns · 3,456 tok
 *
 * `now` is injectable so the age formatting is deterministic under test.
 */
export function formatThreadsDetailed(threads, now = Date.now()) {
  if (!threads || threads.length === 0) return null;

  const sorted = [...threads].sort((a, b) => {
    const pa = STATUS_ORDER[a.status] ?? 9;
    const pb = STATUS_ORDER[b.status] ?? 9;
    if (pa !== pb) return pa - pb;
    return (parseTs(b.updatedAt) || 0) - (parseTs(a.updatedAt) || 0);
  });

  const lines = sorted.map(t => {
    const sid = (t.id || "").slice(0, 8);
    const label = t.name ? `${t.name}:${sid}` : sid;
    const age = formatAge(t.updatedAt, now);
    const ageTag = age ? ` · ${age}` : "";
    const s = t.spend || { turns: 0, tokens: 0 };
    const spend = s.turns || s.tokens ? ` · ${s.turns} turns · ${formatTokens(s.tokens)} tok` : "";
    // Second line: the rolling summary (→ description → role, fallback-chained
    // in readThreadMetas). This is what lets the parent see what a thread did
    // without opening its transcript — even weeks later. Collapse whitespace so
    // a multi-line final answer can't break the block; cap the length.
    const summary = t.summary ? String(t.summary).replace(/\s+/g, " ").trim() : "";
    const sumLine = summary ? `\n      ${summary.slice(0, 100)}` : "";
    return `  ${label} — ${t.status}${ageTag}${spend}${sumLine}`;
  });

  const idle = sorted.filter(t => t.status === "idle").length;
  const header = idle > 0
    ? `threads (${sorted.length} open · ${idle} idle):`
    : `threads (${sorted.length} open):`;

  // N2: only when idle clutter actually accumulates. `stop` archives (hides
  // from the list) — it does not delete; the transcript stays and the thread
  // can still be resumed, so the nudge is safe to act on.
  const nudge = idle >= IDLE_NUDGE_THRESHOLD
    ? `\n  tip: ${idle} idle threads finished? close with 'agnz stop <id>' — the transcript is kept.`
    : "";

  return `${header}\n${lines.join("\n")}${nudge}`;
}
