// Zero-dep aggregator over the ADR 0011 runtime trace (trace.jsonl).
//
// Folds a thread's trace events into a summary (turns, tokens, latency,
// tool outcomes, repair rate, terminal reason, wall-clock duration), and
// rolls those up across a whole workspace with per-model / per-agent
// breakdowns. Because a thread's trace file accumulates across resumes
// (one file per thread for its whole life), re-aggregating the file is the
// authoritative cumulative view — more accurate than any single run's
// thread_end.totals, which only covers that run.
//
// Kept as an importable aggregator for external tooling (dashboard) and the
// ADR 0007 parent-context hook. Also runnable as a CLI:
//
//   node lib/trace-stats.mjs                 workspace summary (cwd = $PWD)
//   node lib/trace-stats.mjs <thread-id>     one thread, detailed
//   node lib/trace-stats.mjs [...] --json    machine-readable output

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TRACE_SUFFIX = ".trace.jsonl";

/**
 * Fold an array of parsed trace entries into a single-thread summary.
 * Pure — no IO — so it is trivially unit-testable.
 */
export function aggregateTrace(entries) {
  const s = {
    agent: null,
    model: null,
    profile: null,
    maxTurns: null,
    turns: 0,
    llmCalls: 0,
    llmLatencyMs: 0,
    tokens: { prompt: 0, completion: 0, total: 0 },
    toolCalls: { total: 0, ok: 0, error: 0, denied: 0, blocked: 0, byName: {} },
    toolLatencyMs: 0,
    repairs: { total: 0, recovered: 0 },
    pauses: 0,
    terminalReason: null,
    startedAt: null,
    endedAt: null,
  };

  for (const e of entries) {
    if (typeof e.ts === "number") {
      if (s.startedAt == null || e.ts < s.startedAt) s.startedAt = e.ts;
      if (s.endedAt == null || e.ts > s.endedAt) s.endedAt = e.ts;
    }
    switch (e.type) {
      case "thread_start":
        s.agent = e.agent ?? s.agent;
        s.model = e.model ?? s.model;
        s.profile = e.profile ?? s.profile;
        s.maxTurns = e.maxTurns ?? s.maxTurns;
        s.turns += 1;
        break;
      case "turn_start":
        s.turns += 1;
        break;
      case "llm_call":
        s.llmCalls += 1;
        if (typeof e.latencyMs === "number") s.llmLatencyMs += e.latencyMs;
        if (e.usage) {
          s.tokens.prompt += e.usage.prompt || 0;
          s.tokens.completion += e.usage.completion || 0;
          s.tokens.total += e.usage.total || 0;
        }
        break;
      case "tool_call":
        s.toolCalls.total += 1;
        if (e.outcome && s.toolCalls[e.outcome] != null) s.toolCalls[e.outcome] += 1;
        if (e.name) s.toolCalls.byName[e.name] = (s.toolCalls.byName[e.name] || 0) + 1;
        if (typeof e.latencyMs === "number") s.toolLatencyMs += e.latencyMs;
        break;
      case "repair":
        s.repairs.total += 1;
        if (e.recovered) s.repairs.recovered += 1;
        break;
      case "pause":
        s.pauses += 1;
        break;
      case "thread_end":
        s.terminalReason = e.reason ?? s.terminalReason;
        break;
    }
  }

  s.durationMs = s.startedAt != null && s.endedAt != null ? s.endedAt - s.startedAt : 0;
  s.avgLlmLatencyMs = s.llmCalls ? Math.round(s.llmLatencyMs / s.llmCalls) : 0;
  return s;
}

/** Read and parse a thread's trace file. Missing/garbled lines are skipped. */
export async function readTrace(cwd, threadId) {
  const file = resolve(cwd, ".claude", "agnz", "threads", `${threadId}${TRACE_SUFFIX}`);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // tolerate a torn final line from a crash mid-write
    }
  }
  return out;
}

export async function aggregateThread(cwd, threadId) {
  return aggregateTrace(await readTrace(cwd, threadId));
}

/** All thread ids in the workspace that have a trace file. */
export async function listTracedThreadIds(cwd) {
  const dir = resolve(cwd, ".claude", "agnz", "threads");
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(TRACE_SUFFIX))
    .map((f) => f.slice(0, -TRACE_SUFFIX.length));
}

/** Roll every traced thread in a workspace into totals + breakdowns. */
export async function aggregateWorkspace(cwd) {
  const ids = await listTracedThreadIds(cwd);
  const threads = [];
  for (const id of ids) {
    threads.push({ id, ...(await aggregateThread(cwd, id)) });
  }

  const totals = {
    threads: threads.length,
    llmCalls: 0,
    toolCalls: 0,
    toolErrors: 0,
    repairs: 0,
    tokens: { prompt: 0, completion: 0, total: 0 },
    llmLatencyMs: 0,
  };
  const byModel = {};
  const byAgent = {};

  for (const t of threads) {
    totals.llmCalls += t.llmCalls;
    totals.toolCalls += t.toolCalls.total;
    totals.toolErrors += t.toolCalls.error;
    totals.repairs += t.repairs.total;
    totals.tokens.prompt += t.tokens.prompt;
    totals.tokens.completion += t.tokens.completion;
    totals.tokens.total += t.tokens.total;
    totals.llmLatencyMs += t.llmLatencyMs;

    const m = t.model || "(unknown)";
    byModel[m] = byModel[m] || { threads: 0, llmCalls: 0, tokens: 0 };
    byModel[m].threads += 1;
    byModel[m].llmCalls += t.llmCalls;
    byModel[m].tokens += t.tokens.total;

    const a = t.agent || "(unknown)";
    byAgent[a] = byAgent[a] || { threads: 0, tokens: 0 };
    byAgent[a].threads += 1;
    byAgent[a].tokens += t.tokens.total;
  }

  threads.sort((x, y) => (y.startedAt || 0) - (x.startedAt || 0));
  return { cwd: resolve(cwd), threads, totals, byModel, byAgent };
}

// ── text formatting (for the CLI / inspect.sh) ───────────────────────────────

function fmtMs(ms) {
  if (!ms) return "0ms";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatThread(threadId, s) {
  const lines = [];
  lines.push(`=== Trace stats: ${threadId.slice(0, 8)} ===`);
  lines.push(`agent:    ${s.agent || "-"}    model: ${s.model || "-"}    profile: ${s.profile || "-"}`);
  lines.push(`status:   ${s.terminalReason || "running/incomplete"}    turns: ${s.turns}${s.maxTurns ? `/${s.maxTurns}` : ""}    duration: ${fmtMs(s.durationMs)}`);
  lines.push(
    `llm:      ${s.llmCalls} calls, ${fmtMs(s.llmLatencyMs)} total (${fmtMs(s.avgLlmLatencyMs)} avg)`,
  );
  lines.push(
    `tokens:   ${s.tokens.total} total (${s.tokens.prompt} prompt / ${s.tokens.completion} completion)`,
  );
  const names = Object.entries(s.toolCalls.byName)
    .map(([n, c]) => `${n}×${c}`)
    .join(", ");
  lines.push(
    `tools:    ${s.toolCalls.total} calls (${s.toolCalls.ok} ok / ${s.toolCalls.error} err / ${s.toolCalls.denied} denied)${names ? `  [${names}]` : ""}`,
  );
  lines.push(
    `repairs:  ${s.repairs.total} (${s.repairs.recovered} recovered)    pauses: ${s.pauses}`,
  );
  return lines.join("\n");
}

export function formatWorkspace(ws) {
  const lines = [];
  lines.push(`=== Workspace trace stats: ${ws.cwd} ===`);
  lines.push("");
  if (ws.threads.length === 0) {
    lines.push("(no traced threads)");
    return lines.join("\n");
  }

  lines.push(
    `${"THREAD".padEnd(10)}${"AGENT".padEnd(14)}${"STATUS".padEnd(20)}${"TURNS".padStart(6)}${"TOKENS".padStart(10)}${"TOOLS".padStart(8)}`,
  );
  lines.push("-".repeat(68));
  for (const t of ws.threads) {
    lines.push(
      `${t.id.slice(0, 8).padEnd(10)}${(t.agent || "-").slice(0, 13).padEnd(14)}${(t.terminalReason || "running").padEnd(20)}${String(t.turns).padStart(6)}${String(t.tokens.total).padStart(10)}${String(t.toolCalls.total).padStart(8)}`,
    );
  }

  lines.push("");
  lines.push(
    `totals:   ${ws.totals.threads} threads · ${ws.totals.llmCalls} llm calls · ${ws.totals.tokens.total} tokens · ${ws.totals.toolCalls} tool calls (${ws.totals.toolErrors} err) · ${ws.totals.repairs} repairs · ${fmtMs(ws.totals.llmLatencyMs)} llm time`,
  );

  const models = Object.entries(ws.byModel);
  if (models.length > 0) {
    lines.push("");
    lines.push("by model:");
    for (const [m, v] of models) {
      lines.push(`  ${m}: ${v.threads} threads, ${v.llmCalls} calls, ${v.tokens} tokens`);
    }
  }
  return lines.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const positional = args.filter((a) => !a.startsWith("--"));
  const cwd = process.env.AGNZ_CWD || process.cwd();
  const threadId = positional[0];

  if (threadId) {
    const summary = await aggregateThread(cwd, threadId);
    console.log(json ? JSON.stringify(summary, null, 2) : formatThread(threadId, summary));
  } else {
    const ws = await aggregateWorkspace(cwd);
    console.log(json ? JSON.stringify(ws, null, 2) : formatWorkspace(ws));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(`trace-stats: ${err.message}`);
    process.exit(1);
  });
}
