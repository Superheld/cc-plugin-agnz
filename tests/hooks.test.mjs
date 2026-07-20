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
} from "../scripts/hooks/_lib.mjs";

let ws;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "agnz-hook-"));
  mkdirSync(join(ws, "threads"), { recursive: true });
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
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

test("readThreadSpend folds turns and tokens from the trace", () => {
  writeThread("t1", { status: "idle" }, [
    { ts: 1, type: "thread_start", turn: 0 },
    { ts: 2, type: "llm_call", turn: 0, usage: { total: 120 } },
    { ts: 3, type: "turn_start", turn: 1 },
    { ts: 4, type: "llm_call", turn: 1, usage: { total: 140 } },
    { ts: 5, type: "thread_end", reason: "final" },
  ]);
  assert.deepEqual(readThreadSpend(ws, "t1"), { turns: 2, tokens: 260 });
});

test("readThreadSpend is a safe zero for a thread with no trace", () => {
  writeThread("t2", { status: "running" }, null);
  assert.deepEqual(readThreadSpend(ws, "t2"), { turns: 0, tokens: 0 });
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
  assert.deepEqual(metas[0].spend, { turns: 1, tokens: 50 });
});

test("formatThreadsDetailed renders short-id, status, and spend", () => {
  const now = 1782065400570;
  const out = formatThreadsDetailed(
    [
      { id: "1a2b3c4d5e6f", name: "dev", status: "running", spend: { turns: 5, tokens: 1234 } },
      // fresh idle (updatedAt = now) so it stays in the full-format section
      { id: "9f8e7d6c", name: null, status: "idle", updatedAt: now, spend: { turns: 0, tokens: 0 } },
    ],
    now,
  );
  // header is honest: N open, and how many of those are merely idle
  assert.match(out, /threads \(2 open · 1 idle\):/);
  // a running thread with no timestamp omits both the spend age suffix and spend
  assert.match(out, /dev:1a2b3c4d — running · 5 turns · 1,234 tok/);
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
        spend: { turns: 2, tokens: 40 },
      },
    ],
    now,
  );
  assert.match(out, /dev:1a2b3c4d — idle · 3h · 2 turns · 40 tok/);
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
        spend: { turns: 6, tokens: 100 },
        summary: "Deleted 5 error-state threads and their files",
      },
    ],
    now,
  );
  assert.match(out, /cleanup:1a2b3c4d — idle · now · 6 turns · 100 tok/);
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

test("readWsFingerprint / writeWsFingerprint roundtrip", () => {
  assert.equal(readWsFingerprint(ws), null); // nothing written yet
  writeWsFingerprint(ws, "a:idle,b:running");
  assert.equal(readWsFingerprint(ws), "a:idle,b:running");
  assert.ok(existsSync(join(ws, "cursors", "parent-ws.json")));
});

test("readWsFingerprint tolerates a garbled fingerprint file", () => {
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
