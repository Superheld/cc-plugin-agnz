---
name: agnz
version: 0.4.0
user-invocable: false
description: "This skill should be used when the user asks to 'use agnz', 'delegate this to an agent', 'spawn an agent', 'resume a thread', 'continue with the agent', 'create an agent definition', 'write an agent file', 'define a role for the sub-agent', when agents should communicate or hand off work to each other, or when a task involves reading many files, bulk grep sweeps, or mechanical edits across multiple files where a local model can do the work. Also load when an agnz thread is paused and needs resolution via `agnz approve` or `agnz answer`, or when the user asks about running two agents in parallel."
---

# agnz agents

`agnz` delegates work to a locally-hosted LLM running as a sandboxed sub-agent. You drive it through the **`agnz` CLI** (invoked via Bash) — there is no MCP server. A sub-agent's intermediate tool calls do **not** consume your context; only its final summary comes back to you via the message hook.

## Invoking the CLI

Call the CLI with Bash. The binary lives at `$CLAUDE_PLUGIN_ROOT/bin/agnz.mjs`:

```bash
node "$CLAUDE_PLUGIN_ROOT/bin/agnz.mjs" <verb> [args...]
```

Every verb prints a JSON object (or array) to stdout, so you can parse the outcome. Errors print `{"error":"..."}` and exit non-zero.

## When to delegate

- Read-heavy work (bulk file reads, grep sweeps, tracing data flows)
- Mechanically repetitive work (same edit across many files)
- Two independent tasks that can run in parallel

Avoid delegation for work needing deep reasoning — local models are limited.

## The verbs

| Verb | Purpose |
|---|---|
| `start <name> ["task"] --agent <def>` | Create a thread. `--inline "<frontmatter>"` instead of `--agent` for an ad-hoc role. Without a task it starts idle. |
| `send <name\|id> "message"` | Send a task. **Reuses** the existing live thread of that name (resume), else needs an id. |
| `approve <id> allow\|deny [--persist]` | Resolve an approval pause (no tool_call_id needed — the thread's pending call is used). |
| `answer <id> "answer text"` | Resolve an `AskUser` question pause. |
| `interrupt <id> ["directive"]` | Hard interrupt a runaway/working agent: aborts the current step, leaves it resumable, optionally queues a directive. |
| `stop <id>` | End a thread (kills its runner; transcript persists). |
| `list [--status <s>] [--all]` | List threads in this workspace (`--all` = every workspace). |
| `show <id>` | Thread state + last few transcript messages. |

Add `--wait` to `start`/`send`/`approve`/`answer` to run the segment synchronously and get the outcome inline (for short tasks). Without it, the run is detached and results arrive via the hook.

## Resume, don't recreate

Threads are persistent. **`send <name>` reuses** the most recent live thread of that name instead of spawning a new one — so a follow-up keeps its context:

```bash
node "$CLAUDE_PLUGIN_ROOT/bin/agnz.mjs" list
node "$CLAUDE_PLUGIN_ROOT/bin/agnz.mjs" send researcher "Continue: now add the tests."
```

`start` always creates a fresh thread. Only `start` a new one when the role/task is genuinely different. Error-status threads are dead — start fresh.

## Quick path — define and spawn

Plugin-bundled agents (`dev`, `researcher`, `reviewer`, `general`) work everywhere. For a project role, create `<cwd>/.claude/agents/<name>.md`:

```markdown
---
name: researcher
description: Use to investigate code, find usages, or summarise a module.
model: inherit
disallowedTools: ["Edit", "Write", "Bash"]
---

Investigate code and produce concise, factual summaries. Don't modify files.
```

Then:

```bash
node "$CLAUDE_PLUGIN_ROOT/bin/agnz.mjs" start researcher-1 "Summarise how request logging works." --agent researcher
→ {"thread_id":"abc…","name":"researcher-1","agent":"researcher","status":"started"}
```

## How results come back

Agents run in the background. Results arrive via `SendMessage(to: "parent")` → the `UserPromptSubmit` hook injects unread parent mail into your next prompt automatically. You don't poll. Pauses (approval/question) signal the same way (+ OS notification). Resolve with `agnz approve` / `agnz answer`.

Non-blocking peek without the CLI: read `<cwd>/.claude/agnz/threads/<id>.meta.json` directly.

## Agent file — frontmatter fields

| Field | Required | Notes |
|---|---|---|
| `name` | yes | `[a-z][a-z0-9_-]*`. The mailbox address. |
| `description` | yes | How you pick this role. Prose or `>` block. |
| `model` | no | profile name or `inherit`/`sonnet`/`haiku`/`opus` (mapped via workspace). |
| `tools` | no | JSON array whitelist → `allow`; others default to `ask`. |
| `disallowedTools` | no | JSON array blacklist → `deny` (overrides whitelist). |
| `skills` | no | JSON array allowlist for the `Skill` tool (default: all skills). |
| `temperature` / `maxTurns` | no | LLM overrides. |

## Team model

Sub-agents address each other by `name` via their `SendMessage` tool (`kind`: say/question/answer/handoff/status/error/directive). The recipient drains its inbox at its next turn. `to: "parent"` reaches you via the hook. All messages append to `<cwd>/.claude/agnz/messages.jsonl`.

## Concurrency

Each detached run is its own OS process, so multiple agents run in true parallel:

```bash
node "$CLAUDE_PLUGIN_ROOT/bin/agnz.mjs" start auth    "…" --agent researcher
node "$CLAUDE_PLUGIN_ROOT/bin/agnz.mjs" start billing "…" --agent researcher
```

## Reference files

- **`references/defining.md`** — full frontmatter spec and tool-policy model.
- **`references/lifecycle.md`** — background execution and team messaging in depth.
- **`references/orchestration.md`** — when to delegate, thread reuse, outcomes.

> Note: the reference files still describe the older MCP tool names in places; the CLI verbs above are authoritative.
