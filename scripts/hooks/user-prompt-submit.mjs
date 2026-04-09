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
} from "./_lib.mjs";

try {
  const input = parseHookInput(readStdinSync());
  if (!input) process.exit(0);

  const ws = resolveWorkspace(input.cwd);
  if (!ws) process.exit(0);

  const cursor = readParentCursor(ws);
  const unread = readUnreadForParent(ws, cursor);
  if (unread.length === 0) process.exit(0);

  process.stdout.write(formatMessages(unread) + "\n");
  writeParentCursor(ws, unread[unread.length - 1].id);
  process.exit(0);
} catch (err) {
  process.stderr.write(`[agnz hook error: ${err?.message || err}]\n`);
  process.exit(0);
}
