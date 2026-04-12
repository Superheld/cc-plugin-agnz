---
description: Show current agnz setup — version, data paths, active profile, and per-project agents/skills/threads.
argument-hint: "[cwd]"
allowed-tools: Bash(node *)
model: haiku
---

Print the current agnz configuration so you can see exactly where everything lives without having to search directories.

## Instructions

Run:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs info $ARGUMENTS
```

`$ARGUMENTS` is an optional absolute path to a project cwd. If omitted, the current working directory is used.

Print the output verbatim. Do not interpret or summarize — the raw output is the answer.
