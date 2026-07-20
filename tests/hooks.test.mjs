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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readThreadSpend,
  readThreadMetas,
  formatThreadsDetailed,
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
  const out = formatThreadsDetailed([
    { id: "1a2b3c4d5e6f", name: "dev", status: "running", spend: { turns: 5, tokens: 1234 } },
    { id: "9f8e7d6c", name: null, status: "idle", spend: { turns: 0, tokens: 0 } },
  ]);
  // header is honest: N open, and how many of those are merely idle
  assert.match(out, /threads \(2 open · 1 idle\):/);
  assert.match(out, /dev:1a2b3c4d — running · 5 turns · 1,234 tok/);
  // a zero-spend thread with no timestamp omits both the spend and age suffix
  assert.match(out, /9f8e7d6c — idle$/m);
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
        updatedAt: "2026-07-17T12:00:00Z", // 3 days earlier
        spend: { turns: 2, tokens: 40 },
      },
    ],
    now,
  );
  assert.match(out, /dev:1a2b3c4d — idle · 3d · 2 turns · 40 tok/);
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
  const out = formatThreadsDetailed([
    { id: "aaaaaaaa", name: "old", status: "idle", spend: { turns: 0, tokens: 0 } },
    { id: "bbbbbbbb", name: "live", status: "running", spend: { turns: 0, tokens: 0 } },
  ]);
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
  const out = formatThreadsDetailed([
    {
      id: "1a2b3c4d5e6f",
      name: "cleanup",
      status: "idle",
      spend: { turns: 6, tokens: 100 },
      summary: "Deleted 5 error-state threads and their files",
    },
  ]);
  assert.match(out, /cleanup:1a2b3c4d — idle · 6 turns · 100 tok/);
  assert.match(out, /\n {6}Deleted 5 error-state threads and their files/);
});

test("formatThreadsDetailed collapses whitespace and caps the summary", () => {
  const out = formatThreadsDetailed([
    {
      id: "abcdef12",
      name: "probe",
      status: "idle",
      spend: { turns: 0, tokens: 0 },
      summary: "line one\n  line two\twith\ttabs " + "x".repeat(200),
    },
  ]);
  // newlines/tabs become single spaces so the block can't be broken
  assert.match(out, /probe:abcdef12 — idle\n {6}line one line two with tabs x+/);
  // the rendered summary line is capped (100 chars of summary + 6 indent)
  const summaryLine = out.split("\n").find((l) => l.includes("line one"));
  assert.ok(summaryLine.trim().length <= 100, `summary line too long: ${summaryLine.length}`);
});

test("formatThreadsDetailed returns null for an empty list", () => {
  assert.equal(formatThreadsDetailed([]), null);
  assert.equal(formatThreadsDetailed(null), null);
});
