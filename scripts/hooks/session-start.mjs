#!/usr/bin/env node
// Claude Code SessionStart hook for agnz.
//
// Runs when a Claude Code session begins (new chat, reopened project).
// Emits a one-line workspace summary plus any unread parent messages
// so Claude can pick up the state without the user having to ask.
//
// Opt-in, no-op when no agnz workspace exists in the current project.

import {
  readStdinSync,
  parseHookInput,
  resolveWorkspace,
  readParentCursor,
  readUnreadForParent,
  writeParentCursor,
  readWorkspaceFile,
  formatMessages,
  flushStdoutThen,
} from "./_lib.mjs";

try {
  const input = parseHookInput(readStdinSync());
  if (!input) process.exit(0);

  const ws = resolveWorkspace(input.cwd);
  if (!ws) process.exit(0);

  // Build the full payload first so there is a single stdout write;
  // we can then advance the cursor exactly once after that write drains.
  const chunks = [];

  const wsFile = readWorkspaceFile(ws);
  if (wsFile) {
    const name = wsFile.name || "(unnamed)";
    const mode = wsFile.mode || "executing";
    const memberCount = Array.isArray(wsFile.members) ? wsFile.members.length : 0;
    chunks.push(`[agnz] workspace "${name}" — mode=${mode}, ${memberCount} member(s)\n`);
  }

  const cursor = readParentCursor(ws);
  const unread = readUnreadForParent(ws, cursor);
  if (unread.length > 0) {
    chunks.push(formatMessages(unread) + "\n");
  }

  if (chunks.length === 0) process.exit(0);

  flushStdoutThen(chunks.join(""), (err) => {
    if (!err && unread.length > 0) {
      try {
        writeParentCursor(ws, unread[unread.length - 1].id);
      } catch (cursorErr) {
        process.stderr.write(`[agnz hook cursor write failed: ${cursorErr?.message || cursorErr}]\n`);
      }
    }
    process.exit(0);
  });
} catch (err) {
  process.stderr.write(`[agnz hook error: ${err?.message || err}]\n`);
  process.exit(0);
}
