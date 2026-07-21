#!/usr/bin/env node
// Claude Code PreToolUse hook for agnz (ADR 0015 §4).
//
// Backstop, not the primary fix: fences the lead's `Read` tool off agnz
// thread transcripts and traces (`.claude/agnz/threads/*.jsonl`), which carry
// verbatim tool results up to 512 KiB and can blow the very context budget the
// plugin exists to protect. The positive path (ADR 0015 §2) is `agnz show` —
// a token-lean structural view — so this fence has three better options behind
// it, which is what makes it discipline rather than mere friction.
//
// Runs on every CC session (global, like the sibling hooks). Fast no-op for
// every tool call except a Read that matches the fence. NEVER throws out — a
// thrown hook would block Claude's tool flow.
//
// Self-contained: the decision lives in _lib.mjs (no imports from lib/).

import { readStdinSync, parseHookInput, isFencedTranscriptRead } from "./_lib.mjs";

try {
  const input = parseHookInput(readStdinSync());
  if (!input) process.exit(0);

  // CC passes { tool_name, tool_input: { file_path, ... }, cwd, ... } for
  // PreToolUse. A malformed envelope simply falls through to exit 0.
  const toolName = input.tool_name;
  const filePath = input.tool_input?.file_path;

  if (isFencedTranscriptRead(toolName, filePath)) {
    // exit 2 = block the tool; stderr is surfaced to the model as the reason.
    process.stderr.write(
      "agnz: reading a thread transcript floods the lead's context " +
        "(this is what agnz exists to avoid). Use 'agnz show <id>' for the " +
        "structural view, 'agnz send <name> \"question\"' to ask the thread " +
        "itself, or the /agnz:threads inspect script for capped debugging output.\n",
    );
    process.exit(2);
  }

  process.exit(0);
} catch (err) {
  process.stderr.write(`[agnz pre-tool-use hook error: ${err?.message || err}]\n`);
  process.exit(0);
}
