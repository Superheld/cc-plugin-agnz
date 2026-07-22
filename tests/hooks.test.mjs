// node:test coverage for the agnz hook helpers (ADR 0011 §3).
//
// Focus on the new spend-aware workspace summary: the trace fold that
// produces per-thread turns/tokens and the detailed thread formatter.
// The hooks stay self-contained, so we exercise the exported helpers
// directly against a temp workspace.
//
// Run with: node --test tests/hooks.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readThreadSpend,
  readThreadMetas,
  formatThreadsDetailed,
  atomicWriteJson,
  readWsFingerprint,
  writeWsFingerprint,
  computeThreadFingerprint,
  isFencedTranscriptRead,
  isFencedTranscriptGrep,
  decideInjection,
  readParentCursor,
  writeParentCursor,
  readUnreadForParent,
} from "../scripts/hooks/_lib.mjs";

let ws;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "agnz-hook-"));
  mkdirSync(join(ws, "threads"), { recursive: true });
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function writeThread(id, meta, traceLines) {
  writeFileSync(join(ws, "threads", `${id}.meta.json`), JSON.stringify({ id, ...meta }));
  if (traceLines) {
    writeFileSync(
      join(ws, "threads", `${id}.trace.jsonl`),
      traceLines.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
  }
}

test("readThreadSpend folds turns, cumulative tokens, and the last call's ctx", () => {
  writeThread("t1", { status: "idle" }, [
    { ts: 1, type: "thread_start", turn: 0 },
    { ts: 2, type: "llm_call", turn: 0, usage: { total: 120 } },
    { ts: 3, type: "turn_start", turn: 1 },
    { ts: 4, type: "llm_call", turn: 1, usage: { total: 140 } },
    { ts: 5, type: "thread_end", reason: "final" },
  ]);
  // lastCtx is the LAST call's total (the real context size a resume re-sends),
  // NOT the cumulative sum — the sum re-counts the transcript every turn.
  assert.deepEqual(readThreadSpend(ws, "t1"), { turns: 2, tokens: 260, lastCtx: 140 });
});

test("readThreadSpend is a safe zero for a thread with no trace", () => {
  writeThread("t2", { status: "running" }, null);
  assert.deepEqual(readThreadSpend(ws, "t2"), { turns: 0, tokens: 0, lastCtx: null });
});

test("readThreadMetas attaches spend and skips stopped threads", () => {
  writeThread("t1", { status: "running", name: "dev" }, [
    { ts: 1, type: "thread_start", turn: 0 },
    { ts: 2, type: "llm_call", turn: 0, usage: { total: 50 } },
  ]);
  writeThread("t2", { status: "stopped", name: "old" }, null);

  const metas = readThreadMetas(ws);
  assert.equal(metas.length, 1);
  assert.equal(metas[0].name, "dev");
  assert.deepEqual(metas[0].spend, { turns: 1, tokens: 50, lastCtx: 50 });
});

test("formatThreadsDetailed renders short-id, status, and spend", () => {
  const now = 1782065400570;
  const out = formatThreadsDetailed(
    [
      { id: "1a2b3c4d5e6f", name: "dev", status: "running", spend: { turns: 5, tokens: 91234, lastCtx: 1234 } },
      // fresh idle (updatedAt = now) so it stays in the full-format section
      { id: "9f8e7d6c", name: null, status: "idle", updatedAt: now, spend: { turns: 0, tokens: 0, lastCtx: null } },
    ],
    now,
  );
  // header is honest: N open, and how many of those are merely idle
  assert.match(out, /threads \(2 open · 1 idle\):/);
  // the block shows the resume-relevant ctx (last call), never the cumulative sum
  assert.match(out, /dev:1a2b3c4d — running · 5 turns · ctx ~1k/);
  assert.doesNotMatch(out, /91,?234/);
  // a zero-spend fresh idle thread shows the age tag but omits the spend suffix
  assert.match(out, /9f8e7d6c — idle · now$/m);
});

test("formatThreadsDetailed header drops the idle breakdown when none are idle", () => {
  const out = formatThreadsDetailed([
    { id: "1a2b3c4d", name: "dev", status: "running", spend: { turns: 1, tokens: 10 } },
  ]);
  assert.match(out, /threads \(1 open\):/);
});

test("formatThreadsDetailed renders a compact age tag from updatedAt", () => {
  const now = Date.parse("2026-07-20T12:00:00Z");
  const out = formatThreadsDetailed(
    [
      {
        id: "1a2b3c4d",
        name: "dev",
        status: "idle",
        updatedAt: "2026-07-20T09:00:00Z", // 3 hours earlier — still fresh (<24h)
        spend: { turns: 2, tokens: 40, lastCtx: 40 },
      },
    ],
    now,
  );
  assert.match(out, /dev:1a2b3c4d — idle · 3h · 2 turns · ctx 40/);
});

test("formatThreadsDetailed accepts epoch-millis timestamps (real meta format)", () => {
  const now = 1782065400570;
  const twoHoursMs = 2 * 60 * 60 * 1000;
  const out = formatThreadsDetailed(
    [
      {
        id: "1a2b3c4d",
        name: "dev",
        status: "idle",
        updatedAt: now - twoHoursMs, // number, not ISO string
        spend: { turns: 0, tokens: 0 },
      },
    ],
    now,
  );
  assert.match(out, /dev:1a2b3c4d — idle · 2h$/m);
});

test("formatThreadsDetailed sorts live work above idle threads", () => {
  const now = 1782065400570;
  const out = formatThreadsDetailed(
    [
      // fresh idle so it renders in full and can be sorted below the live thread
      { id: "aaaaaaaa", name: "old", status: "idle", updatedAt: now, spend: { turns: 0, tokens: 0 } },
      { id: "bbbbbbbb", name: "live", status: "running", spend: { turns: 0, tokens: 0 } },
    ],
    now,
  );
  const lines = out.split("\n").filter((l) => l.includes(" — "));
  assert.match(lines[0], /live:bbbbbbbb — running/);
  assert.match(lines[1], /old:aaaaaaaa — idle/);
});

test("formatThreadsDetailed appends a close-nudge only above the idle threshold", () => {
  const fourIdle = Array.from({ length: 4 }, (_, i) => ({
    id: `id${i}`.padEnd(8, "0"),
    name: `t${i}`,
    status: "idle",
    spend: { turns: 0, tokens: 0 },
  }));
  assert.doesNotMatch(formatThreadsDetailed(fourIdle), /agnz stop <id>/);

  const fiveIdle = [
    ...fourIdle,
    { id: "id4_____", name: "t4", status: "idle", spend: { turns: 0, tokens: 0 } },
  ];
  const out = formatThreadsDetailed(fiveIdle);
  assert.match(out, /tip: 5 idle threads finished\? close with 'agnz stop <id>'/);
});

test("formatThreadsDetailed renders the summary as an indented second line", () => {
  const now = 1782065400570;
  const out = formatThreadsDetailed(
    [
      {
        id: "1a2b3c4d5e6f",
        name: "cleanup",
        status: "idle",
        updatedAt: now, // fresh idle → full format with its summary
        spend: { turns: 6, tokens: 100, lastCtx: 100 },
        summary: "Deleted 5 error-state threads and their files",
      },
    ],
    now,
  );
  assert.match(out, /cleanup:1a2b3c4d — idle · now · 6 turns · ctx 100/);
  assert.match(out, /\n {6}Deleted 5 error-state threads and their files/);
});

test("formatThreadsDetailed collapses whitespace and caps the summary", () => {
  const now = 1782065400570;
  const out = formatThreadsDetailed(
    [
      {
        id: "abcdef12",
        name: "probe",
        status: "idle",
        updatedAt: now, // fresh idle → full format with its summary
        spend: { turns: 0, tokens: 0 },
        summary: "line one\n  line two\twith\ttabs " + "x".repeat(200),
      },
    ],
    now,
  );
  // newlines/tabs become single spaces so the block can't be broken
  assert.match(out, /probe:abcdef12 — idle · now\n {6}line one line two with tabs x+/);
  // the rendered summary line is capped (100 chars of summary + 6 indent)
  const summaryLine = out.split("\n").find((l) => l.includes("line one"));
  assert.ok(summaryLine.trim().length <= 100, `summary line too long: ${summaryLine.length}`);
});

test("formatThreadsDetailed returns null for an empty list", () => {
  assert.equal(formatThreadsDetailed([]), null);
  assert.equal(formatThreadsDetailed(null), null);
});

test("atomicWriteJson writes then renames, leaving no tmp file", () => {
  const path = join(ws, "state.json");
  atomicWriteJson(path, { hello: "world", n: 7 });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { hello: "world", n: 7 });
  // the pid-scoped tmp file must have been renamed away, not left behind
  const strays = readdirSync(ws).filter((f) => f.includes(".tmp."));
  assert.deepEqual(strays, []);
});

test("readWsFingerprint / writeWsFingerprint roundtrip via workspace.json", () => {
  assert.equal(readWsFingerprint(ws), null); // nothing written yet
  writeWsFingerprint(ws, "a:idle,b:running");
  assert.equal(readWsFingerprint(ws), "a:idle,b:running");
  // ADR 0017: parent delivery state lives in workspace.json, not cursors/.
  const wsFile = JSON.parse(readFileSync(join(ws, "workspace.json"), "utf8"));
  assert.equal(wsFile.parent.threadFingerprint, "a:idle,b:running");
  assert.equal(existsSync(join(ws, "cursors")), false, "no cursors/ dir is created");
});

test("fingerprint write preserves an existing cursor in the parent state", () => {
  writeParentCursor(ws, "m000007", 123);
  writeWsFingerprint(ws, "x:idle");
  const wsFile = JSON.parse(readFileSync(join(ws, "workspace.json"), "utf8"));
  assert.deepEqual(wsFile.parent, { cursor: "m000007", offset: 123, threadFingerprint: "x:idle" });
});

test("readWsFingerprint falls back to the legacy cursors/ layout", () => {
  mkdirSync(join(ws, "cursors"), { recursive: true });
  writeFileSync(join(ws, "cursors", "parent-ws.json"), '{"threadFingerprint":"legacy:idle"}', "utf8");
  assert.equal(readWsFingerprint(ws), "legacy:idle");
});

test("readWsFingerprint tolerates a garbled legacy fingerprint file", () => {
  mkdirSync(join(ws, "cursors"), { recursive: true });
  writeFileSync(join(ws, "cursors", "parent-ws.json"), "{not json", "utf8");
  assert.equal(readWsFingerprint(ws), null);
});

test("computeThreadFingerprint is order-independent for the same set", () => {
  const a = computeThreadFingerprint([
    { id: "t1", status: "running" },
    { id: "t2", status: "idle" },
  ]);
  const b = computeThreadFingerprint([
    { id: "t2", status: "idle" },
    { id: "t1", status: "running" },
  ]);
  assert.equal(a, b);
  // a genuine status change must produce a different fingerprint
  const c = computeThreadFingerprint([
    { id: "t1", status: "idle" },
    { id: "t2", status: "idle" },
  ]);
  assert.notEqual(a, c);
});

test("readThreadMetas withSpend:false leaves spend null and skips the trace fold", () => {
  // no trace file at all — proves the fold is not even attempted
  writeThread("t1", { status: "running", name: "dev" }, null);
  const metas = readThreadMetas(ws, { withSpend: false });
  assert.equal(metas.length, 1);
  assert.equal(metas[0].spend, null);
});

test("formatThreadsDetailed renders the agent def when it differs from the name", () => {
  const out = formatThreadsDetailed([
    { id: "b5405e6d1234", name: "janitor", agent: "dev", status: "running", spend: { turns: 1, tokens: 5 } },
    { id: "aaaaaaaa1111", name: "dev", agent: "dev", status: "running", spend: { turns: 1, tokens: 5 } },
  ]);
  // agent != name → bracketed agent tag
  assert.match(out, /janitor \[dev\]:b5405e6d — running/);
  // agent == name → no redundant bracket
  assert.match(out, /(?<!\[)dev:aaaaaaaa — running/);
  assert.doesNotMatch(out, /dev \[dev\]/);
});

test("formatThreadsDetailed collapses idle threads older than 24h into one line", () => {
  const now = 1782065400570;
  const dayMs = 24 * 60 * 60 * 1000;
  const out = formatThreadsDetailed(
    [
      { id: "fresh111", name: "fresh", status: "idle", updatedAt: now - 60_000, spend: { turns: 1, tokens: 9 } },
      { id: "old11111", name: "cleanup-probe", status: "idle", updatedAt: now - 2 * dayMs, spend: { turns: 1, tokens: 9 } },
      { id: "old22222", name: "janitor", status: "idle", updatedAt: now - 3 * dayMs, spend: { turns: 1, tokens: 9 } },
    ],
    now,
  );
  // fresh idle stays in full format
  assert.match(out, /fresh:fresh111 — idle · 1m/);
  // the two stale idles collapse into a single aggregate line, names only
  assert.match(out, /2 idle >24h: cleanup-probe, janitor — details: \/agnz:threads/);
  // no full-format line for the stale ones
  assert.doesNotMatch(out, /janitor:old22222/);
  // header still counts ALL idle threads (fresh + stale)
  assert.match(out, /threads \(3 open · 3 idle\):/);
});

test("formatThreadsDetailed caps the aggregate at 6 names with a +N more overflow", () => {
  const now = 1782065400570;
  const dayMs = 24 * 60 * 60 * 1000;
  const stale = Array.from({ length: 8 }, (_, i) => ({
    id: `old${i}0000`,
    name: `n${i}`,
    status: "idle",
    updatedAt: now - 2 * dayMs,
    spend: { turns: 0, tokens: 0 },
  }));
  const out = formatThreadsDetailed(stale, now);
  // 6 names shown, 2 elided
  assert.match(out, /8 idle >24h: n0, n1, n2, n3, n4, n5 \+2 more — details: \/agnz:threads/);
});

test("readThreadMetas reads a card and short-circuits the trace fold", () => {
  // A card-bearing meta with NO trace file: if the fold ran it would read
  // { turns: 0, tokens: 0 }; reading the card yields the stamped values instead.
  writeThread(
    "t1",
    { status: "idle", name: "dev", card: { task: "do a thing", turns: 3, tokens: 900, ctxTokens: 12345 } },
    null,
  );
  const metas = readThreadMetas(ws); // withSpend defaults true
  assert.equal(metas.length, 1);
  assert.deepEqual(metas[0].spend, { turns: 3, tokens: 900 });
  assert.equal(metas[0].ctxTokens, 12345);
  assert.equal(metas[0].task, "do a thing");
});

test("readThreadMetas falls back to the trace fold for a legacy (card-less) meta", () => {
  writeThread("t1", { status: "idle", name: "dev" }, [
    { ts: 1, type: "thread_start", turn: 0 },
    { ts: 2, type: "llm_call", turn: 0, usage: { total: 70 } },
  ]);
  const metas = readThreadMetas(ws);
  assert.deepEqual(metas[0].spend, { turns: 1, tokens: 70, lastCtx: 70 });
  assert.equal(metas[0].ctxTokens, null);
  assert.equal(metas[0].task, null);
});

test("readThreadMetas uses card.task in the summary fallback chain", () => {
  // No summary, no description, no agentDef → the mission is the reuse signal.
  writeThread("t1", { status: "idle", card: { task: "my mission", turns: 1, tokens: 10, ctxTokens: 5 } }, null);
  assert.equal(readThreadMetas(ws)[0].summary, "my mission");
});

test("formatThreadsDetailed renders ctx from a card and drops the token sum", () => {
  const out = formatThreadsDetailed([
    { id: "1a2b3c4d", name: "dev", status: "running", spend: { turns: 5, tokens: 999999 }, ctxTokens: 12345 },
  ]);
  // resume-relevant context, rounded, and NO misleading cumulative token count
  assert.match(out, /dev:1a2b3c4d — running · 5 turns · ctx ~12k/);
  assert.doesNotMatch(out, /tok/);
});

test("formatThreadsDetailed renders a sub-1000 ctx exactly, no k suffix", () => {
  const out = formatThreadsDetailed([
    { id: "1a2b3c4d", name: "dev", status: "running", spend: { turns: 2, tokens: 0 }, ctxTokens: 500 },
  ]);
  assert.match(out, /dev:1a2b3c4d — running · 2 turns · ctx 500/);
});

test("formatThreadsDetailed derives ctx from the trace's last call for card-less threads", () => {
  // Legacy thread (no card → no ctxTokens): the trace fold's lastCtx stands in.
  const out = formatThreadsDetailed([
    { id: "1a2b3c4d", name: "dev", status: "running", spend: { turns: 5, tokens: 91234, lastCtx: 4200 } },
  ]);
  assert.match(out, /dev:1a2b3c4d — running · 5 turns · ctx ~4k/);
  assert.doesNotMatch(out, /tok\b/);
});

test("formatThreadsDetailed shows turns only when no ctx figure exists at all", () => {
  // No card AND no usable trace: never invent a number, never show the sum.
  const out = formatThreadsDetailed([
    { id: "1a2b3c4d", name: "dev", status: "running", spend: { turns: 5, tokens: 1234, lastCtx: null } },
  ]);
  assert.match(out, /dev:1a2b3c4d — running · 5 turns$/m);
});

// ── ADR 0015 §4: the PreToolUse fence decision ───────────────────────────────

test("isFencedTranscriptRead blocks a Read of a thread transcript", () => {
  assert.equal(
    isFencedTranscriptRead("Read", "/home/u/proj/.claude/agnz/threads/abc123.jsonl"),
    true,
  );
});

test("isFencedTranscriptRead blocks a Read of a thread trace", () => {
  assert.equal(
    isFencedTranscriptRead("Read", "/home/u/proj/.claude/agnz/threads/abc123.trace.jsonl"),
    true,
  );
});

test("isFencedTranscriptRead allows a Read of meta.json (not .jsonl)", () => {
  assert.equal(
    isFencedTranscriptRead("Read", "/home/u/proj/.claude/agnz/threads/abc123.meta.json"),
    false,
  );
});

test("isFencedTranscriptRead allows a .jsonl outside the agnz threads dir", () => {
  // messages.jsonl lives at the workspace root, not under threads/
  assert.equal(
    isFencedTranscriptRead("Read", "/home/u/proj/.claude/agnz/messages.jsonl"),
    false,
  );
  // an unrelated project .jsonl is never fenced
  assert.equal(isFencedTranscriptRead("Read", "/home/u/proj/data/events.jsonl"), false);
});

test("isFencedTranscriptRead only fences Read, not Grep/Bash/other tools", () => {
  const transcript = "/home/u/proj/.claude/agnz/threads/abc123.jsonl";
  assert.equal(isFencedTranscriptRead("Grep", transcript), false);
  assert.equal(isFencedTranscriptRead("Bash", transcript), false);
  assert.equal(isFencedTranscriptRead("Edit", transcript), false);
});

test("isFencedTranscriptRead tolerates a missing / non-string path", () => {
  assert.equal(isFencedTranscriptRead("Read", undefined), false);
  assert.equal(isFencedTranscriptRead("Read", null), false);
  assert.equal(isFencedTranscriptRead("Read", 42), false);
});

test("formatThreadsDetailed never collapses actionable threads regardless of age", () => {
  const now = 1782065400570;
  const dayMs = 24 * 60 * 60 * 1000;
  const out = formatThreadsDetailed(
    [
      { id: "err11111", name: "boom", status: "error", updatedAt: now - 10 * dayMs, spend: { turns: 1, tokens: 9 } },
    ],
    now,
  );
  // an ancient error thread still gets its full-format line — never aggregated
  assert.match(out, /boom:err11111 — error · 10d/);
  assert.doesNotMatch(out, /idle >24h/);
});

// ── Push gating: block stands alone on a structural delta ─────────────────────

test("decideInjection stays silent when there is no mail and nothing changed", () => {
  assert.deepEqual(decideInjection({ unreadCount: 0, changed: false }), {
    showBlock: false,
    showMessages: false,
    exit: true,
  });
});

test("decideInjection injects the block alone on a structural change with no mail", () => {
  assert.deepEqual(decideInjection({ unreadCount: 0, changed: true }), {
    showBlock: true,
    showMessages: false,
    exit: false,
  });
});

test("decideInjection injects messages alone when mail arrives but nothing changed", () => {
  assert.deepEqual(decideInjection({ unreadCount: 3, changed: false }), {
    showBlock: false,
    showMessages: true,
    exit: false,
  });
});

test("decideInjection injects both when mail arrives and the set changed", () => {
  assert.deepEqual(decideInjection({ unreadCount: 2, changed: true }), {
    showBlock: true,
    showMessages: true,
    exit: false,
  });
});

// ── Byte-offset parent cursor over messages.jsonl ─────────────────────────────

// Serialise a message to one JSONL line (with trailing newline).
function msgLine(id, extra = {}) {
  return JSON.stringify({ id, to: "parent", from: "dev", kind: "say", text: id, ...extra }) + "\n";
}

test("readParentCursor / writeParentCursor roundtrip cursor and offset", () => {
  writeParentCursor(ws, "m000005", 250);
  assert.deepEqual(readParentCursor(ws), { cursor: "m000005", offset: 250 });
});

test("readParentCursor defaults to a full-scan cursor when the file is missing", () => {
  assert.deepEqual(readParentCursor(ws), { cursor: null, offset: 0 });
});

test("readParentCursor treats a legacy (offset-less) cursor file as offset 0", () => {
  mkdirSync(join(ws, "cursors"), { recursive: true });
  writeFileSync(join(ws, "cursors", "parent.json"), JSON.stringify({ cursor: "m000003" }));
  // one full scan (offset 0) then convergence once the byte offset is recorded
  assert.deepEqual(readParentCursor(ws), { cursor: "m000003", offset: 0 });
});

test("readUnreadForParent reads only the tail past the offset", () => {
  const l1 = msgLine("m000001");
  const l2 = msgLine("m000002");
  writeFileSync(join(ws, "messages.jsonl"), l1 + l2);

  const first = readUnreadForParent(ws, null, 0);
  assert.deepEqual(first.messages.map((m) => m.id), ["m000001", "m000002"]);
  assert.equal(first.nextOffset, Buffer.byteLength(l1 + l2));

  // append a third message, read from the recorded offset → only the new one
  const l3 = msgLine("m000003");
  writeFileSync(join(ws, "messages.jsonl"), l1 + l2 + l3);
  const second = readUnreadForParent(ws, "m000002", first.nextOffset);
  assert.deepEqual(second.messages.map((m) => m.id), ["m000003"]);
  assert.equal(second.nextOffset, Buffer.byteLength(l1 + l2 + l3));
});

test("readUnreadForParent does not consume a trailing partial line", () => {
  const l1 = msgLine("m000001");
  const l2 = msgLine("m000002");
  const partial = '{"id":"m000003","to":"parent"'; // writer mid-append, no newline yet
  writeFileSync(join(ws, "messages.jsonl"), l1 + l2 + partial);

  const r = readUnreadForParent(ws, null, 0);
  // only the two complete lines are parsed; the partial is left for next time
  assert.deepEqual(r.messages.map((m) => m.id), ["m000001", "m000002"]);
  // nextOffset stops at the last complete line, NOT inside the partial tail
  assert.equal(r.nextOffset, Buffer.byteLength(l1 + l2));

  // once the partial line is completed, a read from nextOffset picks it up
  const l3 = msgLine("m000003");
  writeFileSync(join(ws, "messages.jsonl"), l1 + l2 + l3);
  const r2 = readUnreadForParent(ws, "m000002", r.nextOffset);
  assert.deepEqual(r2.messages.map((m) => m.id), ["m000003"]);
});

test("readUnreadForParent resets to a full scan when the offset is beyond the file size", () => {
  const l1 = msgLine("m000001");
  const l2 = msgLine("m000002");
  writeFileSync(join(ws, "messages.jsonl"), l1 + l2);

  // an offset past EOF can only mean the log was replaced/truncated → rescan
  const r = readUnreadForParent(ws, null, 999_999);
  assert.deepEqual(r.messages.map((m) => m.id), ["m000001", "m000002"]);
  assert.equal(r.nextOffset, Buffer.byteLength(l1 + l2));
});

test("readUnreadForParent returns nothing for a missing log and preserves the offset", () => {
  assert.deepEqual(readUnreadForParent(ws, "m000009", 42), { messages: [], nextOffset: 42 });
});

// ── ADR 0015 §4: the Grep context-flag fence ─────────────────────────────────

test("isFencedTranscriptGrep blocks a large -A context window on a transcript", () => {
  assert.equal(
    isFencedTranscriptGrep("Grep", { path: "/home/u/proj/.claude/agnz/threads/abc.jsonl", "-A": 50 }),
    true,
  );
});

test("isFencedTranscriptGrep allows a small -A context window on a transcript", () => {
  assert.equal(
    isFencedTranscriptGrep("Grep", { path: "/home/u/proj/.claude/agnz/threads/abc.jsonl", "-A": 5 }),
    false,
  );
});

test("isFencedTranscriptGrep treats 10 lines as the inclusive allowed boundary", () => {
  const path = "/home/u/proj/.claude/agnz/threads/abc.jsonl";
  assert.equal(isFencedTranscriptGrep("Grep", { path, "-C": 10 }), false); // allowed
  assert.equal(isFencedTranscriptGrep("Grep", { path, "-B": 11 }), true); // blocked
});

test("isFencedTranscriptGrep blocks when the path is the threads DIR, not a file", () => {
  assert.equal(
    isFencedTranscriptGrep("Grep", { path: "/home/u/proj/.claude/agnz/threads", "-A": 50 }),
    true,
  );
});

test("isFencedTranscriptGrep allows a large context window on an unrelated path", () => {
  assert.equal(isFencedTranscriptGrep("Grep", { path: "/home/u/proj/src", "-C": 50 }), false);
  assert.equal(isFencedTranscriptGrep("Grep", { path: "/home/u/proj/data/events.jsonl", "-C": 50 }), false);
});

test("isFencedTranscriptGrep ignores non-Grep tools and matches-only Grep", () => {
  const path = "/home/u/proj/.claude/agnz/threads/abc.jsonl";
  assert.equal(isFencedTranscriptGrep("Read", { path, "-A": 50 }), false);
  // no context flag at all → matches-only, stays allowed
  assert.equal(isFencedTranscriptGrep("Grep", { path }), false);
});

test("isFencedTranscriptGrep tolerates a missing / non-object tool_input", () => {
  assert.equal(isFencedTranscriptGrep("Grep", undefined), false);
  assert.equal(isFencedTranscriptGrep("Grep", null), false);
});

test("the Read fence is unaffected by the Grep fence addition", () => {
  // regression guard: Read behaviour is unchanged
  assert.equal(isFencedTranscriptRead("Read", "/home/u/proj/.claude/agnz/threads/abc.jsonl"), true);
  assert.equal(isFencedTranscriptRead("Grep", "/home/u/proj/.claude/agnz/threads/abc.jsonl"), false);
});

// ── path normalization: fence must not fail open on relative/dot paths (F) ────

test("isFencedTranscriptRead normalizes a relative path against cwd", () => {
  const cwd = "/home/u/proj";
  assert.equal(
    isFencedTranscriptRead("Read", ".claude/agnz/threads/x.jsonl", cwd),
    true,
    "a relative transcript path must still be fenced",
  );
});

test("isFencedTranscriptRead collapses dot-segments before matching", () => {
  const cwd = "/home/u/proj";
  assert.equal(
    isFencedTranscriptRead("Read", "foo/../.claude/agnz/threads/x.jsonl", cwd),
    true,
    "a `..` detour into the threads dir must not dodge the fence",
  );
});

test("isFencedTranscriptRead still passes absolute paths through unchanged", () => {
  const cwd = "/home/u/other";
  // The absolute path wins over cwd (resolve ignores the base for absolutes).
  assert.equal(
    isFencedTranscriptRead("Read", "/home/u/proj/.claude/agnz/threads/x.jsonl", cwd),
    true,
  );
  assert.equal(isFencedTranscriptRead("Read", "/home/u/proj/src/app.js", cwd), false);
});

test("isFencedTranscriptGrep normalizes a relative/dot-segment path against cwd", () => {
  const cwd = "/home/u/proj";
  assert.equal(
    isFencedTranscriptGrep("Grep", { path: ".claude/agnz/threads/x.jsonl", "-A": 50 }, cwd),
    true,
  );
  assert.equal(
    isFencedTranscriptGrep("Grep", { path: "foo/../.claude/agnz/threads", "-C": 50 }, cwd),
    true,
  );
  // small context window still allowed even when normalized into the threads dir
  assert.equal(
    isFencedTranscriptGrep("Grep", { path: ".claude/agnz/threads/x.jsonl", "-A": 5 }, cwd),
    false,
  );
});
