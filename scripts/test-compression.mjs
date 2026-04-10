#!/usr/bin/env node
// Test rolling compression against a real thread transcript.
//
// Usage:
//   node scripts/test-compression.mjs <thread.jsonl>
//   node scripts/test-compression.mjs <thread.jsonl> --threshold 0
//
// Pass --threshold 0 to force compression regardless of actual size.
// The transcript is never modified — this is a read-only dry run.

import { readFile } from "node:fs/promises";
import { compressHistory, countTokens } from "../lib/compression.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const thresholdArg = args.find((a) => a.startsWith("--threshold=") || a === "--threshold");
let threshold = 8000;
if (thresholdArg) {
  const val = thresholdArg.includes("=")
    ? thresholdArg.split("=")[1]
    : args[args.indexOf(thresholdArg) + 1];
  threshold = parseInt(val, 10);
}

if (!file) {
  console.error("Usage: node scripts/test-compression.mjs <thread.jsonl> [--threshold N]");
  process.exit(1);
}

let raw;
try {
  raw = await readFile(file, "utf8");
} catch (err) {
  console.error(`Cannot read file: ${err.message}`);
  process.exit(1);
}

const lines = raw.trim().split("\n").filter(Boolean);
const history = [];
for (const line of lines) {
  try {
    history.push(JSON.parse(line));
  } catch {
    // skip malformed lines
  }
}

console.log(`\nTranscript: ${file}`);
console.log(`Messages:   ${history.length}`);
console.log(`Threshold:  ${threshold} tokens\n`);

const { messages: compressed, stats } = compressHistory(history, { threshold });

const pct = stats.before > 0
  ? Math.round((1 - stats.after / stats.before) * 100)
  : 0;

console.log(`Before:  ~${stats.before.toLocaleString()} tokens`);
console.log(`After:   ~${stats.after.toLocaleString()} tokens`);
console.log(`Saved:   ~${(stats.before - stats.after).toLocaleString()} tokens (${pct}%)`);
console.log(`Omitted: ${stats.omitted} tool result(s)\n`);

if (stats.omitted === 0) {
  console.log("Nothing to compress.");
} else {
  console.log("Omitted entries:");
  for (const m of compressed) {
    if (m.role === "tool" && m.content?.startsWith("[omitted")) {
      console.log(`  [${m.tool_call_id}] ${m.content}`);
    }
  }
}
