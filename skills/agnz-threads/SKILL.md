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
| `name` | human label given at agnz start |
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
- `kind=approval` → `pending.toolCallId`, `pending.name`, `pending.args` — call `agnz approve`
- `kind=question` → `pending.toolCallId`, `pending.question` — call `agnz answer`

## Trace stats (ADR 0011)

Each thread also has a runtime trace at `.claude/agnz/threads/<id>.trace.jsonl`
(events: `thread_start`, `turn_start`, `llm_call`, `tool_call`, `repair`,
`pause`, `thread_end`). `lib/trace-stats.mjs` folds it into turns, token spend,
LLM latency, tool outcomes, and repair rate — the answer to "how much did this
agent cost and how did it go". Use this when the user asks "how many tokens",
"how long did it take", "how many tool calls", "which model is cheaper", or to
compare local models per profile.

```bash
# workspace-wide totals + per-model breakdown
node ${CLAUDE_PLUGIN_ROOT}/lib/trace-stats.mjs

# one thread, detailed (turns, tokens, tool outcomes, repairs)
node ${CLAUDE_PLUGIN_ROOT}/lib/trace-stats.mjs <thread-id>

# machine-readable for further processing
node ${CLAUDE_PLUGIN_ROOT}/lib/trace-stats.mjs <thread-id> --json
```

The CLI reads `<cwd>/.claude/agnz/` (override with `AGNZ_CWD`).

## Hygiene

The workspace block (ADR 0007) collapses idle threads older than 24h into one
line, so keeping the thread list clean is what keeps it readable. Decision
rules:

- **`awaiting_input` older than a few days** — answer it (`agnz answer`) or
  stop it (`agnz stop`). The question behind it is probably obsolete by now,
  and unlike idle threads, awaiting threads never decay on their own — that's
  deliberate (nothing auto-expires; the list is pruned only by deliberate
  cleanup, never silently).
- **`idle` threads whose context you won't reuse** — `agnz stop` them. This
  archives, not deletes: the thread drops out of the workspace block, its
  transcript is kept on disk, and it's still resumable later via `agnz send`.
- **Resume vs. start fresh** — prefer `agnz send <name>` over a fresh `agnz
  start` when all three hold: the agent role fits the new task, the task sits
  in the topic area of the thread's rolling summary, and the thread isn't
  already heavy (high turns/tokens in the workspace block means you'd be
  paying to drag a full context along for an unrelated ask). Otherwise, start
  fresh — a heavy or off-topic thread costs more to resume than to replace.

## Terminal shortcut

For a quick formatted view in the terminal (requires `jq`):

```bash
# list all threads
bash ${SKILL_BASE_DIR}/scripts/inspect.sh

# workspace trace stats (turns, tokens, tool outcomes — requires node)
bash ${SKILL_BASE_DIR}/scripts/inspect.sh stats

# inspect one thread (prefix match) — meta + trace stats + transcript tail
bash ${SKILL_BASE_DIR}/scripts/inspect.sh <thread-id-prefix>

# wider transcript window
N_MESSAGES=60 bash ${SKILL_BASE_DIR}/scripts/inspect.sh <thread-id-prefix>
```
