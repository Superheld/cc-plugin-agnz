#!/usr/bin/env node
// Claude Code PreToolUse hook for agnz (ADR 0015 §4).
//
// Backstop, not the primary fix: fences the lead off agnz thread transcripts
// and traces (`.claude/agnz/threads/*.jsonl`), which carry verbatim tool results
// up to 512 KiB and can blow the very context budget the plugin exists to
// protect. Two fences: any `Read` of a transcript/trace, and a `Grep` of one
// with a large -A/-B/-C context window (matches-only Grep stays open — it's
// context-cheap). The positive path (ADR 0015 §2) is `agnz show` — a token-lean
// structural view — so these fences have better options behind them, which is
// what makes them discipline rather than mere friction.
//
// Runs on every CC session (global, like the sibling hooks). Fast no-op for
// every tool call except a fenced Read/Grep. NEVER throws out — a thrown hook
// would block Claude's tool flow.
//
// Self-contained: the decision lives in _lib.mjs (no imports from lib/).

import {
  readStdinSync,
  parseHookInput,
  isFencedTranscriptRead,
  isFencedTranscriptGrep,
} from "./_lib.mjs";

try {
  const input = parseHookInput(readStdinSync());
  if (!input) process.exit(0);

  // CC passes { tool_name, tool_input: { ... }, cwd, ... } for PreToolUse. Read
  // carries file_path; Grep carries path plus the literal "-A"/"-B"/"-C" keys.
  // A malformed envelope simply falls through to exit 0.
  const toolName = input.tool_name;
  const toolInput = input.tool_input || {};
  const filePath = toolInput.file_path;

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

  if (isFencedTranscriptGrep(toolName, toolInput)) {
    // Matches-only Grep on a transcript stays fine — it's context-cheap. What's
    // blocked is a large -A/-B/-C context window, which drags the transcript
    // bulk back into the lead's context the transcript fence exists to keep out.
    process.stderr.write(
      "agnz: a large -A/-B/-C context window on a thread transcript pulls back " +
        "the transcript bulk agnz keeps out of the lead's context. Matches-only " +
        "Grep is fine; use a smaller context window (<=10 lines) or 'agnz show " +
        "<id>' for the structural view.\n",
    );
    process.exit(2);
  }

  process.exit(0);
} catch (err) {
  process.stderr.write(`[agnz pre-tool-use hook error: ${err?.message || err}]\n`);
  process.exit(0);
}
