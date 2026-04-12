#!/usr/bin/env node
// Claude Code UserPromptSubmit hook for agnz.
//
// Runs on every prompt the user submits. Injects any unread messages
// addressed to `parent` into Claude's context, then advances the
// parent cursor so the same messages are not re-delivered next time.
//
// This script is opt-in — users enable it by adding a matching entry
// to their ~/.claude/settings.json hooks array. It intentionally stays
// silent when the current project has no agnz workspace, so installing
// it does not affect unrelated projects.

import {
  readStdinSync,
  parseHookInput,
  resolveWorkspace,
  readParentCursor,
  readUnreadForParent,
  writeParentCursor,
  formatMessages,
  flushStdoutThen,
  readThreadMetas,
  formatThreads,
} from "./_lib.mjs";
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

try {
  const input = parseHookInput(readStdinSync());
  if (!input) process.exit(0);

  const ws = resolveWorkspace(input.cwd);
  if (!ws) process.exit(0);

  // Read unread messages for parent
  const cursor = readParentCursor(ws);
  const unread = readUnreadForParent(ws, cursor);
  if (unread.length === 0) process.exit(0);

  // Compute thread fingerprint: sorted "id:status" pairs joined by ","
  const threadsDir = join(ws, "threads");
  let activeThreads = [];
  if (existsSync(threadsDir)) {
    activeThreads = readThreadMetas(ws);
  }
  const fingerprint = activeThreads.map(t => `${t.id}:${t.status}`).sort().join(",");

  // Read last fingerprint from parent-ws.json
  let lastFingerprint = null;
  try {
    const path = join(ws, "cursors", "parent-ws.json");
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, "utf8"));
      lastFingerprint = data.threadFingerprint || null;
    }
  } catch {}

  // If fingerprint changed or file missing: inject summary + update file
  if (fingerprint !== lastFingerprint) {
    const formattedThreads = formatThreads(activeThreads);
    let chunks = [];
    if (formattedThreads) {
      chunks.push(`[agnz] threads: ${formattedThreads}\n`);
    }

    // Advance cursor only after stdout has been accepted by the kernel —
    // prevents the silent-loss race where we'd mark messages delivered
    // but the write never reached Claude.
    flushStdoutThen(chunks.join("") + formatMessages(unread) + "\n", (err) => {
      if (!err && unread.length > 0) {
        try {
          writeParentCursor(ws, unread[unread.length - 1].id);
        } catch (cursorErr) {
          process.stderr.write(`[agnz hook cursor write failed: ${cursorErr?.message || cursorErr}]\n`);
        }
      }

      // Update parent-ws.json atomically if fingerprint changed
      try {
        const dir = join(ws, "cursors");
        mkdirSync(dir, { recursive: true });
        const finalPath = join(dir, "parent-ws.json");
        const tmpPath = join(dir, `parent-ws.json.tmp.${process.pid}`);
        writeFileSync(tmpPath, JSON.stringify({ threadFingerprint: fingerprint }), "utf8");
        renameSync(tmpPath, finalPath);
      } catch (cursorErr) {
        process.stderr.write(`[agnz hook cursor write failed: ${cursorErr?.message || cursorErr}]\n`);
      }

      process.exit(0);
    });
  } else {
    // No change, just inject unread messages
    flushStdoutThen(formatMessages(unread) + "\n", (err) => {
      if (!err && unread.length > 0) {
        try {
          writeParentCursor(ws, unread[unread.length - 1].id);
        } catch (cursorErr) {
          process.stderr.write(`[agnz hook cursor write failed: ${cursorErr?.message || cursorErr}]\n`);
        }
      }
      process.exit(0);
    });
  }
} catch (err) {
  process.stderr.write(`[agnz hook error: ${err?.message || err}]\n`);
  process.exit(0);
}