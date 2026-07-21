#!/usr/bin/env node
// Claude Code UserPromptSubmit hook for agnz.
//
// Runs on every prompt the user submits. Injects, on a real event, unread
// messages addressed to `parent` and/or the thread-status block, then advances
// the corresponding state (cursor / fingerprint) so nothing is re-delivered.
// The block used to ride along with mail only; it now stands on its own — a
// thread appearing or disappearing between prompts is itself an event the lead
// may need to act on, so a pure structural delta triggers an injection with no
// mail present.
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
  decideInjection,
} from "./_lib.mjs";

try {
  const input = parseHookInput(readStdinSync());
  if (!input) process.exit(0);

  const ws = resolveWorkspace(input.cwd);
  if (!ws) process.exit(0);

  // Push on real events like a colleague would: this hook injects when there is
  // new parent mail OR when the thread set changed structurally since it was
  // last shown (a thread started/stopped between prompts — an event the lead may
  // need to act on). The thread block no longer rides along with mail only; a
  // pure structural delta stands on its own. Compute both signals up front — the
  // fingerprint keys off id:status only, so read metas WITHOUT the per-thread
  // trace fold (the expensive part), and re-read with spend only when the block
  // is actually built below.
  const { cursor, offset } = readParentCursor(ws);
  const { messages: unread, nextOffset } = readUnreadForParent(ws, cursor, offset);

  const fingerprint = computeThreadFingerprint(readThreadMetas(ws, { withSpend: false }));
  const changed = fingerprint !== readWsFingerprint(ws);

  const { showBlock, showMessages, exit } = decideInjection({
    unreadCount: unread.length,
    changed,
  });
  if (exit) process.exit(0);

  const chunks = [];
  if (showBlock) {
    const formattedThreads = formatThreadsDetailed(readThreadMetas(ws));
    if (formattedThreads) chunks.push(`[agnz] ${formattedThreads}\n`);
  }
  if (showMessages) {
    chunks.push(formatMessages(unread) + "\n");
  }

  // One flush, then advance state — but only after stdout has drained. The
  // cursor advances ONLY when messages were shown (guarding against marking mail
  // delivered that never reached Claude); the fingerprint advances ONLY when the
  // block was shown. Both are gated on !err for the same silent-loss reason.
  flushStdoutThen(chunks.join(""), (err) => {
    if (!err) {
      if (showMessages) {
        try {
          writeParentCursor(ws, unread[unread.length - 1].id, nextOffset);
        } catch (cursorErr) {
          process.stderr.write(`[agnz hook cursor write failed: ${cursorErr?.message || cursorErr}]\n`);
        }
      }
      if (showBlock) {
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
