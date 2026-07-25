// The unified per-thread log (ADR 0020).
//
// One append-only file, <cwd>/.claude/agnz/threads/<id>.log.jsonl, holding
// everything that happened to a thread: the wire messages, the API calls and
// their responses or errors, tool executions, and what the harness did on its
// own. Every other view is a projection of it — the chat history, the API log,
// the tool log and the stats fold all read the same file.
//
// It replaces the pair it grew out of: <id>.jsonl (wire truth, no timing, no
// errors) and <id>.trace.jsonl (timing, no content). Joining those two by
// timestamp was how "why did this run fail" used to be answered, and it was
// approximate — neither file named the run it belonged to.
//
// Two rules keep the file from re-creating the redundancy it exists to remove:
//
//   1. Content is stored once. An `api_request` carries NO messages — it names
//      a seq range and a prefix digest. Replaying that range against the
//      write-once system prompt reproduces the exact request that went out.
//      Logging bodies in full would be quadratic: the request IS the
//      conversation, so a 40-turn run would write it out ~40 times.
//   2. Observability references, never restates. `tool_exec` points at the
//      `message` holding the tool's output by seq; it does not copy it.
//
// SINGLE WRITER. Sequence numbers are allocated in-process after seeding from
// the file, which is safe because `claimThread` admits exactly one live runner
// per thread. Nothing else appends to a thread's log.

import { appendFile, readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

/** Envelope keys — stripped when projecting a `message` back to wire shape. */
const ENVELOPE = new Set(["seq", "ts", "run", "turn", "type"]);

function threadsDir(cwd) {
  return resolve(cwd, ".claude", "agnz", "threads");
}

export function threadLogFile(cwd, threadId) {
  return resolve(threadsDir(cwd), `${threadId}.log.jsonl`);
}

/**
 * Read a thread's log. Returns [] when the file does not exist — a thread
 * created before ADR 0020 has none, and callers fall back to the old pair
 * rather than failing.
 *
 * @returns {Promise<object[]>} entries in file order
 */
export async function readThreadLog(cwd, threadId) {
  return readJsonl(threadLogFile(cwd, threadId));
}

async function readJsonl(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    // A torn final line (killed mid-append) must not make the whole log
    // unreadable — the rest of it is still an accurate record.
    try {
      out.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Open a thread's log for one run.
 *
 * @param {object} opts
 * @param {string} opts.cwd — the workspace root
 * @param {string} opts.threadId
 * @param {string} opts.runId — this run's id; stamped on every entry
 * @returns {Promise<object>} the writer
 */
export async function openThreadLog({ cwd, threadId, runId }) {
  const file = threadLogFile(cwd, threadId);
  const existing = await readJsonl(file);
  let seq = existing.reduce((max, e) => (typeof e.seq === "number" && e.seq > max ? e.seq : max), 0);
  let turn = null;

  // Seq of every `message`, in order, seeded from what is already on disk so a
  // resume can name a range that starts before this run. Needed because other
  // event types interleave, so message seqs are not contiguous and the range an
  // api_request refers to cannot be derived from counting.
  const messageSeqs = existing.filter((e) => e?.type === "message").map((e) => e.seq);

  async function write(type, payload) {
    seq += 1;
    const entry = { seq, ts: Date.now(), run: runId, turn, type, ...payload };
    await mkdir(threadsDir(cwd), { recursive: true });
    await appendFile(file, JSON.stringify(entry) + "\n", "utf8");
    if (type === "message") messageSeqs.push(seq);
    return entry;
  }

  return {
    /** Current turn, stamped on every subsequent entry. */
    setTurn(t) {
      turn = t;
    },
    /** The seq the next entry will get — for naming a range before writing it. */
    nextSeq() {
      return seq + 1;
    },
    lastSeq() {
      return seq;
    },
    /**
     * The seq range covering the last `count` messages — what an api_request
     * names instead of copying the conversation into itself (ADR 0020 §3).
     * `count` is how many the loop actually sent, which after a compaction is
     * the tail from the marker on.
     */
    rangeForLastMessages(count) {
      if (!messageSeqs.length || !count) return null;
      const tail = messageSeqs.slice(-count);
      return { fromSeq: tail[0], toSeq: tail[tail.length - 1] };
    },
    /**
     * Append an entry the thread's correctness depends on (a `message`).
     * Rejects on failure: losing one of these silently would corrupt the
     * conversation the model is replayed from.
     */
    append: write,
    /**
     * Append an observability entry. Never rejects — an unwritable log must
     * not take the run down with it. Same rule the old trace had.
     */
    async appendQuiet(type, payload) {
      try {
        return await write(type, payload);
      } catch {
        return null;
      }
    },
  };
}

/**
 * The chat-history projection: the wire messages, in order, with the log
 * envelope stripped. This is what the loop replays to the model.
 *
 * @param {object[]} entries — a thread's log
 * @returns {object[]} messages in wire shape
 */
export function projectMessages(entries) {
  const out = [];
  for (const e of entries || []) {
    if (e?.type !== "message") continue;
    const msg = {};
    for (const [k, v] of Object.entries(e)) {
      if (!ENVELOPE.has(k)) msg[k] = v;
    }
    out.push(msg);
  }
  return out;
}

/**
 * Reconstruct the messages an `api_request` actually sent, per ADR 0020 §3:
 * the `message` events inside the range it named. The caller prepends the
 * system prompt named by `request.prefix` (`<id>.system.txt`) to get the
 * byte-identical body.
 *
 * @param {object[]} entries — a thread's log
 * @param {object} request — an `api_request` entry
 * @returns {object[]} messages in wire shape
 */
export function reconstructRequest(entries, request) {
  const { fromSeq, toSeq } = request?.messages || {};
  if (typeof fromSeq !== "number" || typeof toSeq !== "number") return [];
  return projectMessages(
    (entries || []).filter((e) => e.seq >= fromSeq && e.seq <= toSeq),
  );
}

/**
 * The API-log projection: each request paired with the response or error that
 * answered it, matched on the request's seq. An unanswered request (the run
 * was killed mid-call) yields `outcome: "unanswered"` rather than vanishing —
 * that state was invisible before, and it is exactly what a crashed run looks
 * like.
 *
 * @param {object[]} entries — a thread's log
 * @returns {object[]} one row per API call
 */
export function projectApiCalls(entries) {
  const rows = [];
  let open = null;
  for (const e of entries || []) {
    if (e?.type === "api_request") {
      if (open) rows.push({ request: open, outcome: "unanswered" });
      open = e;
      continue;
    }
    if (e?.type === "api_response" || e?.type === "api_error") {
      rows.push({
        request: open,
        response: e,
        outcome: e.type === "api_error" ? "error" : "ok",
      });
      open = null;
    }
  }
  if (open) rows.push({ request: open, outcome: "unanswered" });
  return rows;
}

/**
 * Append a workspace-scoped event — something with no thread to belong to.
 *
 * ADR 0020 §6: `agnz config test` contacting an unreachable inference host was
 * the incident behind this ADR, and it had nowhere to write. Without this the
 * failure that motivated the whole design would still go unrecorded.
 *
 * Never rejects; nothing here is correctness-critical.
 */
export async function appendWorkspaceLog(cwd, entry) {
  try {
    const dir = resolve(cwd, ".claude", "agnz");
    await mkdir(dir, { recursive: true });
    await appendFile(
      resolve(dir, "workspace.log.jsonl"),
      JSON.stringify({ ts: Date.now(), run: null, turn: null, ...entry }) + "\n",
      "utf8",
    );
  } catch {
    // intentionally silent
  }
}

/**
 * Read the workspace-scoped log. [] when absent.
 */
export async function readWorkspaceLog(cwd) {
  return readJsonl(resolve(cwd, ".claude", "agnz", "workspace.log.jsonl"));
}
