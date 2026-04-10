#!/usr/bin/env node
// Simulate the ADR 0010 workspace model against a real thread transcript.
// Shows turn-by-turn what the system prompt workspace section would contain,
// compares token usage OLD (full content in history) vs NEW (content in
// system prompt, short acks in history).
//
// Usage:
//   node scripts/simulate-workspace.mjs <thread.jsonl>
//   node scripts/simulate-workspace.mjs <thread.jsonl> --verbose

import { readFile } from "node:fs/promises";

const OPEN_FILE_MAX = 100 * 1024;
const CONTEXT_BUDGET = 40_000;
const FRAMING_TOKENS = 350; // estimate for defaultSystemPrompt text

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const verbose = args.includes("--verbose");

if (!file) {
  console.error("Usage: node scripts/simulate-workspace.mjs <thread.jsonl> [--verbose]");
  process.exit(1);
}

const raw = await readFile(file, "utf8");
const messages = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

function est(str) { return Math.ceil((str?.length ?? 0) / 4); }
function countMsg(m) {
  let t = est(m.content);
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) t += est(tc.function?.arguments);
  }
  return t;
}

// Build a map from tool_call_id → { name, path } by scanning assistant messages
function buildCallMeta(messages) {
  const meta = new Map();
  const READS = new Set(["Read", "read_file"]);
  const EDITS = new Set(["Edit", "edit_file"]);
  const WRITES = new Set(["Write", "write_file"]);
  const CLOSES = new Set(["Close"]);
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      let args;
      try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { continue; }
      const name = tc.function?.name;
      meta.set(tc.id, { name, path: args.path, args });
    }
  }
  return meta;
}

const callMeta = buildCallMeta(messages);

// Simulate workspace state across turns
const openFiles = {}; // path → { content, openedAt }

// Also extract tool result content from the transcript (for old transcripts
// where read_file results contain full file content)
const toolResults = new Map(); // tool_call_id → content string
for (const m of messages) {
  if (m.role === "tool" && m.tool_call_id) {
    toolResults.set(m.tool_call_id, m.content || "");
  }
}

// Turn boundary detection: each assistant message with tool_calls = new turn
let turn = 0;
let totalOldTokens = 0;
let totalNewSystemTokens = 0;
let totalNewHistoryTokens = 0;
const turnStats = [];

// Walk messages, simulate workspace transitions
// We rebuild both the "old" history token cost and the "new" workspace token cost
const oldHistoryTokens = [];
const newHistoryTokens = []; // acks only, no file content

for (const m of messages) {
  const oldT = countMsg(m);
  let newT = oldT;

  if (m.role === "tool" && m.tool_call_id) {
    const meta = callMeta.get(m.tool_call_id);
    const content = m.content || "";
    const isRead = meta && ["Read", "read_file"].includes(meta.name);
    const isEdit = meta && ["Edit", "edit_file"].includes(meta.name);
    const isWrite = meta && ["Write", "write_file"].includes(meta.name);
    const isClose = meta && meta.name === "Close";

    if (isRead && meta.path && content.length <= OPEN_FILE_MAX) {
      // Extract raw content from tool result (strips line number prefix if present)
      // Old format: "# path (lines N-M of L)\n     1  <line>"
      // We store the full content string as-is for simulation purposes
      openFiles[meta.path] = { content, openedAt: turn };
      newT = est(`[${meta.path} opened — injected into workspace context]`);
    } else if (isEdit && meta.path && openFiles[meta.path]) {
      // Content stays in openFiles (updated), tool result is still short
      // (We don't have the new content here, so we keep existing)
      newT = oldT; // edit result is already short ("Edited X (N replacements).")
    } else if (isClose && meta.path) {
      delete openFiles[meta.path];
      newT = est(`[${meta.path} closed]`);
    }
  }

  if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
    turn++;

    // Compute workspace section size at this turn start
    let wsChars = 0;
    for (const entry of Object.values(openFiles)) wsChars += (entry.content || "").length;
    const wsTokens = Math.ceil(wsChars / 4);
    const pct = Math.min(99, Math.round((wsTokens / CONTEXT_BUDGET) * 100));

    const wsFiles = Object.keys(openFiles).length;
    turnStats.push({ turn, wsFiles, wsTokens, pct });

    if (verbose) {
      const warning = pct >= 80 ? ` ⚠ >80%` : "";
      console.log(`\n=== TURN ${turn} ===`);
      console.log(`Workspace: ${wsFiles} file(s), ~${wsTokens.toLocaleString()} tokens (${pct}%)${warning}`);
      if (wsFiles > 0) {
        for (const path of Object.keys(openFiles)) {
          const lines = (openFiles[path].content || "").split("\n").length;
          console.log(`  open: ${path} (${lines} lines)`);
        }
      } else {
        console.log("  (no open files)");
      }
    }
  }

  totalOldTokens += oldT;
  totalNewSystemTokens += 0; // system prompt is per-turn, computed below
  newHistoryTokens.push(newT);
  oldHistoryTokens.push(oldT);
}

// Estimate new total tokens per turn
// New: each turn costs FRAMING_TOKENS + wsTokensAtTurn + historyUpToTurn
// Old: each turn costs FRAMING_TOKENS + historyUpToTurn (with full file content)
let cumOldHistory = 0;
let cumNewHistory = 0;
let totalNewPerTurnCost = 0;
let totalOldPerTurnCost = 0;

for (let i = 0; i < messages.length; i++) {
  const m = messages[i];
  if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
    const tIdx = turnStats.findIndex(s => s.turn === turn);
    // For simplicity compare totals rather than per-turn
  }
  cumOldHistory += oldHistoryTokens[i];
  cumNewHistory += newHistoryTokens[i];
}

const oldHistTotal = oldHistoryTokens.reduce((a, b) => a + b, 0);
const newHistTotal = newHistoryTokens.reduce((a, b) => a + b, 0);

// Final workspace state tokens (what would be in the last system prompt)
let finalWsChars = 0;
for (const entry of Object.values(openFiles)) finalWsChars += (entry.content || "").length;
const finalWsTokens = Math.ceil(finalWsChars / 4);

console.log(`\n${"─".repeat(60)}`);
console.log(`Transcript: ${file}`);
console.log(`Messages:   ${messages.length}  |  Turns: ${turn}`);
console.log(`${"─".repeat(60)}`);
// Final context comparison at last turn
// OLD: system(~350) + history(full content)
// NEW: system(~350 + ~50 note) + first-msg(files prepended) + history(acks)
// The files block appears once in the first message — not per turn.
const oldFinalCtx = FRAMING_TOKENS + oldHistTotal;
const newFinalCtx = FRAMING_TOKENS + 50 + finalWsTokens + newHistTotal;

console.log(`\nOLD approach — full file content stored in history:`);
console.log(`  System prompt: ~${FRAMING_TOKENS} tokens (static)`);
console.log(`  History:       ~${oldHistTotal.toLocaleString()} tokens (file content stays forever)`);
console.log(`  Total (final): ~${oldFinalCtx.toLocaleString()} tokens`);

console.log(`\nNEW approach — workspace model (ADR 0010):`);
console.log(`  System prompt: ~${FRAMING_TOKENS + 50} tokens (+ one-line workspace note)`);
console.log(`  Files block:   ~${finalWsTokens.toLocaleString()} tokens (${Object.keys(openFiles).length} file(s), prepended to first msg, always current)`);
console.log(`  History:       ~${newHistTotal.toLocaleString()} tokens (short acks only)`);
console.log(`  Total (final): ~${newFinalCtx.toLocaleString()} tokens`);

const saving = oldHistTotal - newHistTotal;
const pctSaving = oldHistTotal > 0 ? Math.round((saving / oldHistTotal) * 100) : 0;
const netSaving = oldFinalCtx - newFinalCtx;
console.log(`\n  History savings: ~${saving.toLocaleString()} tokens (${pctSaving}% of history)`);

if (turnStats.length > 0) {
  const maxWs = turnStats.reduce((a, b) => b.wsTokens > a.wsTokens ? b : a);
  console.log(`  Peak workspace:  ~${maxWs.wsTokens.toLocaleString()} tokens at turn ${maxWs.turn} (${maxWs.wsFiles} file(s), ${maxWs.pct}%)`);
}

if (Object.keys(openFiles).length > 0) {
  console.log(`\nFiles still open at end of thread:`);
  for (const path of Object.keys(openFiles)) {
    const lines = (openFiles[path].content || "").split("\n").length;
    console.log(`  ${path} (${lines} lines, ~${est(openFiles[path].content || "")} tokens)`);
  }
}
