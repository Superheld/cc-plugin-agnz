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
} from "./_lib.mjs";

try {
  const input = parseHookInput(readStdinSync());
  if (!input) process.exit(0);

  const ws = resolveWorkspace(input.cwd);
  if (!ws) process.exit(0);

  // Workspace summary — always emitted when the workspace exists,
  // even without unread mail. Gives Claude a grounding line at the
  // top of every session.
  const wsFile = readWorkspaceFile(ws);
  if (wsFile) {
    const name = wsFile.name || "(unnamed)";
    const mode = wsFile.mode || "executing";
    const memberCount = Array.isArray(wsFile.members) ? wsFile.members.length : 0;
    process.stdout.write(
      `[agnz] workspace "${name}" — mode=${mode}, ${memberCount} member(s)\n`,
    );
  }

  const cursor = readParentCursor(ws);
  const unread = readUnreadForParent(ws, cursor);
  if (unread.length > 0) {
    process.stdout.write(formatMessages(unread) + "\n");
    writeParentCursor(ws, unread[unread.length - 1].id);
  }

  process.exit(0);
} catch (err) {
  process.stderr.write(`[agnz hook error: ${err?.message || err}]\n`);
  process.exit(0);
}
