---
name: agnz-inspect
description: This skill should be used when the user asks to "inspect a thread", "show what the agent did", "what happened in thread X", "show thread history", "check what the agent is doing", "debug the agent output", or wants to look at the transcript or status of a specific sub-agent thread.
---

Inspect the state and transcript of agnz sub-agent threads without burning
parent context on an MCP call. Reads `.claude/agnz/threads/` directly — the
script is a pure file read, no network, no MCP.

## Two modes

**List** (no argument) — all threads in the current workspace, sorted by
filename, with status, name, agent role, last-updated timestamp, and a short
note for errors or pending pauses.

**Inspect** (thread ID prefix) — full meta summary (name, agent, status,
created/updated, pending pause details, error message if any) followed by the
last N messages of the transcript rendered as readable lines.

## How to run

From the project root:

```bash
# list all threads
bash ${SKILL_BASE_DIR}/scripts/inspect.sh

# inspect a specific thread (prefix match — first 8 chars is enough)
bash ${SKILL_BASE_DIR}/scripts/inspect.sh <thread-id-prefix>

# show more transcript context
N_MESSAGES=60 bash ${SKILL_BASE_DIR}/scripts/inspect.sh <thread-id-prefix>
```

`jq` must be installed. `AGNZ_DIR` defaults to `.claude/agnz`; override for
non-standard workspace locations.

## Transcript format

Each line is one of:

| Prefix | Meaning |
|--------|---------|
| `USER` | message sent to the agent (user turn) |
| `ASST` | assistant text response |
| `CALL` | tool call — `ToolName(arg=value, ...)` |
| `TOOL` | tool result — `[last-6-chars-of-call-id] content` |

Long strings are truncated at 160–200 chars. Use `N_MESSAGES=100` to widen
the window, or read the raw JSONL at `.claude/agnz/threads/<id>.jsonl` for
full fidelity.

## When to use vs. raw file reads

Use the script when you want a quick readable summary. Read the raw files when
you need full argument values (e.g., to see the exact content an agent tried
to write) or when `jq` is unavailable.
