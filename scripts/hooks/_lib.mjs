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

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, renameSync, statSync, openSync, readSync, closeSync } from "node:fs";
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
 * Read the parent cursor file. Returns { cursor, offset }:
 *   - cursor: the last-delivered message id (string) or null.
 *   - offset: byte position in messages.jsonl past the last consumed line —
 *     lets readUnreadForParent skip re-parsing the whole log every prompt.
 *
 * Missing / malformed file → { cursor: null, offset: 0 } (full scan next time).
 * A legacy file carrying only `cursor` and no `offset` → offset 0, which means
 * exactly one full scan then convergence (the byte offset gets recorded on the
 * next write). Both fields degrade independently to their safe defaults.
 */
export function readParentCursor(ws) {
  const path = resolve(ws, "cursors", "parent.json");
  if (!existsSync(path)) return { cursor: null, offset: 0 };
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    const cursor = typeof data?.cursor === "string" ? data.cursor : null;
    const offset =
      typeof data?.offset === "number" && Number.isFinite(data.offset) && data.offset >= 0
        ? data.offset
        : 0;
    return { cursor, offset };
  } catch {
    return { cursor: null, offset: 0 };
  }
}

/**
 * Write a JSON object to `path` atomically: serialise to a sibling tmp file
 * (`${path}.tmp.${pid}` — pid-scoped so concurrent hook processes never clash
 * on the same tmp name) then renameSync onto the final path. rename is atomic
 * on POSIX, so a crash mid-write can never leave a half-written file behind.
 */
export function atomicWriteJson(path, obj) {
  const tmpPath = `${path}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(obj), "utf8");
  renameSync(tmpPath, path);
}

/**
 * Read the workspace thread fingerprint from cursors/parent-ws.json — the
 * "id:status set last shown to the parent". The UserPromptSubmit hook re-injects
 * the thread block only when this differs from the current set. Missing or
 * malformed file → null (treated as "nothing shown yet").
 */
export function readWsFingerprint(ws) {
  const path = resolve(ws, "cursors", "parent-ws.json");
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return typeof data?.threadFingerprint === "string" ? data.threadFingerprint : null;
  } catch {
    return null;
  }
}

/**
 * Persist the workspace thread fingerprint. Same atomic tmp+rename discipline
 * as writeParentCursor, and — like it — only safe to call AFTER the block has
 * actually been flushed to Claude, or the parent would be told a state was
 * shown that it never saw.
 */
export function writeWsFingerprint(ws, fingerprint) {
  const dir = resolve(ws, "cursors");
  mkdirSync(dir, { recursive: true });
  atomicWriteJson(resolve(dir, "parent-ws.json"), { threadFingerprint: fingerprint });
}

/**
 * The fingerprint of a thread set: sorted "id:status" pairs joined by ",".
 * Order-independent (sorted) so the same set in a different array order yields
 * the same string — the hook keys "did the visible state change" off this.
 */
export function computeThreadFingerprint(threads) {
  return threads.map((t) => `${t.id}:${t.status}`).sort().join(",");
}

/**
 * Persist the parent cursor atomically via tmp-file + rename. The rename
 * is an atomic operation on POSIX so a crash mid-write cannot leave a
 * half-written cursor file behind. Callers must ONLY invoke this AFTER
 * stdout has been flushed to Claude — see flushStdoutThen() — otherwise
 * the cursor would advance past messages that never made it into the
 * parent's context (silent data loss).
 *
 * `offset` is the byte position past the last consumed line (see
 * readUnreadForParent's nextOffset); persisted alongside the id so the next
 * read starts where this one stopped instead of re-scanning from the top.
 */
export function writeParentCursor(ws, cursor, offset = 0) {
  const dir = resolve(ws, "cursors");
  mkdirSync(dir, { recursive: true });
  atomicWriteJson(resolve(dir, "parent.json"), { cursor, offset });
}

/**
 * Write a string to stdout, then invoke `then` only after Node reports
 * the write has drained. Guards against the "cursor advanced but stdout
 * never reached Claude" race: the write callback fires after the OS has
 * accepted the bytes, so we're safe to mark the messages as delivered.
 *
 * Even when write() returns false (kernel buffer full), the callback still
 * runs once the buffer clears, so no separate 'drain' handling is needed.
 */
export function flushStdoutThen(text, then) {
  process.stdout.write(text, (err) => {
    if (err) {
      // Write failed — do NOT advance the cursor; the messages will be
      // redelivered next turn. Surface the error so the outer hook can
      // decide how loud to be.
      then(err);
      return;
    }
    then(null);
  });
}

/**
 * Read unread messages addressed to the parent. Returns
 * { messages, nextOffset } where messages is ordered by id ascending and
 * nextOffset is the byte position past the last FULLY-parsed line (feed it
 * back as the offset on the next call). Missing file → { messages: [],
 * nextOffset: offset }.
 *
 * messages.jsonl is append-only, so we only read the tail past `offset`
 * instead of re-parsing the whole log every prompt. Guards:
 *   - offset > file size (impossible for a pure append; the file must have
 *     been replaced/truncated) → distrust it, rescan from 0.
 *   - a trailing partial line (writer crashed or is mid-append — the tail
 *     may not end in "\n") is NOT consumed and nextOffset does NOT advance
 *     past it, so it gets re-read intact once it's complete.
 * The `msg.id > cursor` filter stays as a safety net on top of the offset.
 *
 * Cursor comparison is lexicographic (`msg.id > cursor`). This is
 * correct ONLY because lib/messages-log.mjs allocates ids with a
 * fixed-width zero-padded counter (m000001, m000002, …) — lexical
 * order matches numeric order exactly. If the id format ever
 * changes (wider counter, epoch-millis prefix, uuid), this
 * comparison must change too.
 */
export function readUnreadForParent(ws, cursor, offset = 0) {
  const path = resolve(ws, "messages.jsonl");
  if (!existsSync(path)) return { messages: [], nextOffset: offset };

  let size;
  try {
    size = statSync(path).size;
  } catch {
    return { messages: [], nextOffset: offset };
  }

  // An offset past the current size can only mean the log was replaced or
  // truncated (append-only files never shrink) — the recorded byte position is
  // meaningless against the new bytes, so rescan from the top and lean on the
  // id-cursor filter to suppress already-delivered messages.
  const start = typeof offset === "number" && offset >= 0 && offset <= size ? offset : 0;

  let raw;
  try {
    if (start === 0) {
      raw = readFileSync(path, "utf8");
    } else {
      const len = size - start;
      const buf = Buffer.allocUnsafe(len);
      const fd = openSync(path, "r");
      try {
        readSync(fd, buf, 0, len, start);
      } finally {
        closeSync(fd);
      }
      raw = buf.toString("utf8");
    }
  } catch {
    return { messages: [], nextOffset: start };
  }

  // Consume only complete lines. raw.split("\n") always leaves the final
  // element as either "" (raw ended in "\n" → every line complete) or a
  // partial trailing line (no newline yet) — in both cases slice it off, so a
  // half-written tail is neither parsed nor counted toward nextOffset.
  const segments = raw.split("\n");
  const completeLines = segments.slice(0, segments.length - 1);

  const out = [];
  let consumedBytes = 0;
  for (const line of completeLines) {
    // Every complete line is consumed regardless of whether it survives the
    // filters below, so advance the byte count first (+1 for the "\n").
    consumedBytes += Buffer.byteLength(line, "utf8") + 1;
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
  return { messages: out, nextOffset: start + consumedBytes };
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
 * Fence decision for the PreToolUse hook (ADR 0015 §4): should the lead's Read
 * of this path be blocked? True only for a `Read` of an agnz thread transcript
 * or trace — a path under `.claude/agnz/threads/` ending in `.jsonl`. This
 * covers both `<id>.jsonl` (transcript) and `<id>.trace.jsonl` (trace); a
 * single read of either can carry verbatim tool results up to 512 KiB and blow
 * the very context budget agnz exists to protect.
 *
 * Deliberately porous, per the ADR:
 *   - only `Read` is fenced — `Grep` returns matches only (context-cheap) and
 *     `Bash`/inspect.sh tails with its own caps, so both stay allowed;
 *   - `meta.json` is NOT matched (ends `.json`, not `.jsonl`) — whether to also
 *     fence raw meta reads is an open question in the ADR, not settled here;
 *   - `.jsonl` files outside the threads dir (e.g. messages.jsonl at the
 *     workspace root, or an unrelated project file) are not matched.
 *
 * CC's Read tool always passes an absolute file_path, so matching the absolute
 * `/.claude/agnz/threads/` segment is sufficient and avoids false positives on
 * a stray relative path.
 */
export function isFencedTranscriptRead(toolName, filePath) {
  if (toolName !== "Read") return false;
  if (typeof filePath !== "string" || !filePath) return false;
  if (!filePath.includes("/.claude/agnz/threads/")) return false;
  return filePath.endsWith(".jsonl");
}

// The Read fence (above) leaves Grep unconditionally open on transcripts because
// matches-only output is context-cheap. That reasoning collapses once Grep is
// asked for a large surrounding-context window: `-A/-B/-C N` pulls N extra lines
// around every hit, and with a big N that re-imports the transcript bulk the
// Read fence exists to keep out. Windows up to this size stay allowed — small
// context is still cheap and useful for a quick status check.
const GREP_CONTEXT_FENCE_LINES = 10;

/**
 * Fence decision for a lead `Grep` against a thread transcript/trace (ADR 0015 §4,
 * closing the "unbounded -A/-B/-C" open bullet). Blocks only when BOTH hold:
 *   - the target path points into an agnz threads dir (the path STRING contains
 *     `/.claude/agnz/threads` — CC's Grep `path` may be a single transcript file
 *     OR a directory containing the threads dir, so a segment match, not a
 *     `.jsonl` suffix, is the right guard; the segment is specific enough to keep
 *     unrelated repos from tripping the fence), and
 *   - a surrounding-context flag (`-A`, `-B`, or `-C`) exceeds
 *     GREP_CONTEXT_FENCE_LINES.
 * Matches-only Grep and small context windows stay allowed. CC's Grep tool_input
 * carries the flags under the literal keys "-A"/"-B"/"-C" (numbers) and the path
 * under `path`; `file_path` is accepted defensively in case a caller uses it.
 */
export function isFencedTranscriptGrep(toolName, toolInput) {
  if (toolName !== "Grep") return false;
  if (!toolInput || typeof toolInput !== "object") return false;
  const path =
    typeof toolInput.path === "string"
      ? toolInput.path
      : typeof toolInput.file_path === "string"
        ? toolInput.file_path
        : "";
  if (!path.includes("/.claude/agnz/threads")) return false;
  const ctx = Math.max(
    numOrZero(toolInput["-A"]),
    numOrZero(toolInput["-B"]),
    numOrZero(toolInput["-C"]),
  );
  return ctx > GREP_CONTEXT_FENCE_LINES;
}

// Coerce a context-flag value to a non-negative finite number; anything else
// (undefined, non-numeric string, NaN) counts as 0 so it never trips the fence.
function numOrZero(v) {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Pure gating decision for the UserPromptSubmit hook. The hook pushes on real
 * events like a colleague would — new parent mail OR a structural change to the
 * thread set (a thread started/stopped between prompts). Returns which parts to
 * inject and whether to skip entirely:
 *   - showMessages: there is unread parent mail to deliver.
 *   - showBlock: the thread fingerprint changed since it was last shown.
 *   - exit: neither applies → the hook is a silent no-op this prompt.
 * Extracted so the gate is unit-testable without spawning the hook script.
 */
export function decideInjection({ unreadCount, changed }) {
  const showMessages = unreadCount > 0;
  const showBlock = !!changed;
  return { showBlock, showMessages, exit: !showMessages && !showBlock };
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
 * a spend ({ turns, tokens }), and (for card-bearing threads) the
 * resume-relevant ctxTokens and mission task.
 *
 * The loop stamps a `card` onto meta at every pause/finish (resume-card). When
 * present it carries turns/tokens/ctxTokens/task directly, so we read it as a
 * plain field and SKIP the trace fold entirely — even with withSpend:true, the
 * fold is what we are trying to avoid. Legacy threads (no card) fall back to
 * folding trace.jsonl, with ctxTokens/task null.
 */
export function readThreadMetas(wsDir, { withSpend = true } = {}) {
  const threadsDir = join(wsDir, "threads");
  try {
    const files = readdirSync(threadsDir).filter(f => f.endsWith(".meta.json"));
    return files.flatMap(f => {
      try {
        const meta = JSON.parse(readFileSync(join(threadsDir, f), "utf8"));
        if (!isListedThread(meta.status)) return [];
        const card = meta.card || null;
        // Card path: cheap meta read, no trace fold. Legacy path: fold
        // trace.jsonl (the expensive part — a real workspace carries hundreds of
        // KB of traces), and only when the caller actually needs spend.
        const spend = card
          ? { turns: card.turns || 0, tokens: card.tokens || 0 }
          : (withSpend ? readThreadSpend(wsDir, meta.id) : null);
        const ctxTokens = card ? (card.ctxTokens ?? null) : null;
        const task = card ? (card.task ?? null) : null;
        return [{
          id: meta.id,
          name: meta.name || null,
          status: meta.status,
          agent: meta.agentDef?.name || null,
          // Rolling summary (state) → description → card.task (mission) →
          // agent-def role. Lets the parent see reusable context per thread
          // (ADR 0007); when no summary exists yet, the mission is the next-best
          // reuse signal.
          summary:
            meta.summary ||
            meta.description ||
            task ||
            (meta.agentDef?.description ? String(meta.agentDef.description).split("\n")[0] : null),
          updatedAt: meta.updatedAt || null,
          ctxTokens,
          task,
          spend,
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
 * Compact the resume context size: rounded to the nearest thousand with a `k`
 * suffix (12345 -> "~12k"), but rendered exactly below 1000 (no misleading
 * "~0k"). This is the number that tells the lead how heavy a `send` to this
 * thread will be (a resume re-sends the whole transcript to the local model).
 */
function formatCtx(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(n);
  return `~${Math.round(n / 1000)}k`;
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

// An idle thread older than this (updatedAt vs now) is a stale reuse candidate:
// its summary/spend is noise in every prompt, so the block collapses all such
// threads into one aggregate line. Fresh idle threads (<24h) stay in full — they
// are the ones the parent is most likely to `send` to next.
const IDLE_COLLAPSE_MS = 24 * 60 * 60 * 1000;

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
 *     dev:1a2b3c4d — running · now · 5 turns · ctx ~12k
 *     reviewer:9f8e7d6c — idle · 2h · 12 turns · ctx ~8k
 *
 * (Card-bearing threads show the resume-relevant `ctx ~Xk`; legacy threads with
 * only a trace fold keep the cumulative `N tok` form.)
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

  // Partition: everything actionable (running / awaiting_input / error) and
  // fresh idle (<24h) renders in full; stale idle (>=24h, or a broken/absent
  // timestamp) collapses into a single aggregate line below.
  const isStaleIdle = (t) => {
    if (t.status !== "idle") return false;
    const ts = parseTs(t.updatedAt);
    return ts === null || now - ts >= IDLE_COLLAPSE_MS;
  };
  const staleIdle = sorted.filter(isStaleIdle);
  const full = sorted.filter((t) => !isStaleIdle(t));

  const lines = full.map(t => {
    const sid = (t.id || "").slice(0, 8);
    // Surface the agent def when it differs from the thread's own name, so a
    // "janitor" thread running the "dev" agent reads as `janitor [dev]:<id>`.
    const label = t.name
      ? `${t.agent && t.agent !== t.name ? `${t.name} [${t.agent}]` : t.name}:${sid}`
      : sid;
    const age = formatAge(t.updatedAt, now);
    const ageTag = age ? ` · ${age}` : "";
    const s = t.spend || { turns: 0, tokens: 0 };
    // Card-bearing thread (ctxTokens known): show turns + the resume-relevant
    // context size — what a `send` re-sends to the model — and DROP the
    // cumulative token sum, which is misleading for reuse (inflated by re-sends)
    // and stays available in `agnz list`/`show`. The block is on a context diet.
    // Legacy thread (no card): fall back to cumulative turns · tokens.
    let spend = "";
    if (t.ctxTokens != null) {
      spend = ` · ${s.turns} turns · ctx ${formatCtx(t.ctxTokens)}`;
    } else if (s.turns || s.tokens) {
      spend = ` · ${s.turns} turns · ${formatTokens(s.tokens)} tok`;
    }
    // Second line: the rolling summary (→ description → role, fallback-chained
    // in readThreadMetas). This is what lets the parent see what a thread did
    // without opening its transcript — even weeks later. Collapse whitespace so
    // a multi-line final answer can't break the block; cap the length.
    const summary = t.summary ? String(t.summary).replace(/\s+/g, " ").trim() : "";
    const sumLine = summary ? `\n      ${summary.slice(0, 100)}` : "";
    return `  ${label} — ${t.status}${ageTag}${spend}${sumLine}`;
  });

  // Collapsed stale-idle bucket: names only (up to 6, then "+N more"), pointing
  // at /agnz:threads for the detail. Dropping their per-thread summary/spend is
  // the bulk of the per-prompt weight this context-diet sheds.
  if (staleIdle.length > 0) {
    const names = staleIdle.map((t) => t.name || (t.id || "").slice(0, 8));
    const shown = names.slice(0, 6);
    const overflow = names.length - shown.length;
    const nameList = overflow > 0 ? `${shown.join(", ")} +${overflow} more` : shown.join(", ");
    lines.push(`  ${staleIdle.length} idle >24h: ${nameList} — details: /agnz:threads`);
  }

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
