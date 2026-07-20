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
  formatThreadsDetailed,
  computeThreadFingerprint,
  readWsFingerprint,
  writeWsFingerprint,
} from "./_lib.mjs";

try {
  const input = parseHookInput(readStdinSync());
  if (!input) process.exit(0);

  const ws = resolveWorkspace(input.cwd);
  if (!ws) process.exit(0);

  // Gate on unread parent mail first — this hook only speaks when there is
  // something to deliver (a deliberate, separately-tracked decision). No mail,
  // no injection: the thread block rides along with mail, it doesn't stand alone.
  const cursor = readParentCursor(ws);
  const unread = readUnreadForParent(ws, cursor);
  if (unread.length === 0) process.exit(0);

  // Decide whether to (re-)inject the thread block. The fingerprint keys off
  // id:status only, so read metas WITHOUT the per-thread trace fold — that fold
  // is the expensive part and pointless when nothing renders. Re-read with spend
  // only on the changed path, where the block is actually built.
  const fingerprint = computeThreadFingerprint(readThreadMetas(ws, { withSpend: false }));
  const changed = fingerprint !== readWsFingerprint(ws);

  const chunks = [];
  if (changed) {
    const formattedThreads = formatThreadsDetailed(readThreadMetas(ws));
    if (formattedThreads) chunks.push(`[agnz] ${formattedThreads}\n`);
  }
  chunks.push(formatMessages(unread) + "\n");

  // One flush, then advance BOTH the cursor and the fingerprint — but only after
  // stdout has drained. Guarding both with !err prevents the silent-loss race
  // where we mark state as "shown" although the write never reached Claude.
  flushStdoutThen(chunks.join(""), (err) => {
    if (!err) {
      try {
        writeParentCursor(ws, unread[unread.length - 1].id);
      } catch (cursorErr) {
        process.stderr.write(`[agnz hook cursor write failed: ${cursorErr?.message || cursorErr}]\n`);
      }
      if (changed) {
        try {
          writeWsFingerprint(ws, fingerprint);
        } catch (fpErr) {
          process.stderr.write(`[agnz hook fingerprint write failed: ${fpErr?.message || fpErr}]\n`);
        }
      }
    }
    process.exit(0);
  });
} catch (err) {
  process.stderr.write(`[agnz hook error: ${err?.message || err}]\n`);
  process.exit(0);
}
