---
name: agnz-threads
description: Inspect agnz threads in the current project — list all threads or show the full state and transcript of a specific thread. This skill should be used when the user asks to "list threads", "show thread status", "what is the agent doing", "inspect thread X", "show what happened in thread X", "show thread history", "debug agent output", or when a thread is paused and needs resolution.
argument-hint: "list | <thread-id-prefix>"
allowed-tools: Bash(node *) Read Glob
model: haiku
---

Read thread state directly from `.claude/agnz/threads/` — no MCP call needed.

## List all threads

Read all meta files and summarise:

```
Glob: .claude/agnz/threads/*.meta.json
Read: each .meta.json → id (filename), name, status, agentDef.name, pending.kind, error.message, updatedAt
```

Key fields per thread:

| Field | Notes |
|---|---|
| `id` | UUID — use first 8 chars as short handle |
| `name` | human label given at agent_start |
| `status` | `idle` / `running` / `awaiting_input` / `stopped` / `error` |
| `agentDef.name` | which agent definition is loaded |
| `pending.kind` | `approval` or `question` when status=awaiting_input |
| `pending.name` | tool name awaiting approval |
| `pending.question` | question text when kind=question |
| `error.message` | set when status=error |
| `updatedAt` | ms timestamp |

## Inspect one thread

Read meta + tail the transcript:

```
Read: .claude/agnz/threads/<id>.meta.json   → full state including pending/error detail
Read: .claude/agnz/threads/<id>.jsonl       → transcript (last N lines)
```

Transcript line shapes (OpenAI format):
- `{"role":"user","content":"..."}` — message sent to agent
- `{"role":"assistant","content":"...","tool_calls":[...]}` — assistant reply; tool_calls has `function.name` + `function.arguments`
- `{"role":"tool","tool_call_id":"...","content":"..."}` — tool result

When a thread is `awaiting_input`, the `pending` object in meta has everything needed to resolve it:
- `kind=approval` → `pending.toolCallId`, `pending.name`, `pending.args` — call `agent_approve`
- `kind=question` → `pending.toolCallId`, `pending.question` — call `agent_answer`

## Terminal shortcut

For a quick formatted view in the terminal (requires `jq`):

```bash
# list all threads
bash ${SKILL_BASE_DIR}/scripts/inspect.sh

# inspect one thread (prefix match)
bash ${SKILL_BASE_DIR}/scripts/inspect.sh <thread-id-prefix>

# wider transcript window
N_MESSAGES=60 bash ${SKILL_BASE_DIR}/scripts/inspect.sh <thread-id-prefix>
```
