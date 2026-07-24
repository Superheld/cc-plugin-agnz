---
name: agnz
version: 0.5.0
user-invocable: false
description: "This skill should be used when the user asks to 'use agnz', 'delegate this to an agent', 'run this on the local model', 'spawn an agent', 'resume a thread', 'continue with the agent', 'create an agent definition', 'write an agent file', 'define a role for the sub-agent', mentions delegating to LM Studio or Ollama, when agents should communicate or hand off work to each other, or when a task involves reading many files, bulk grep sweeps, or mechanical edits across multiple files where a local model can do the work. Also load when an agnz thread is paused and needs resolution via `agnz approve` or `agnz answer`, or when the user asks about running two agents in parallel."
---

# agnz agents

`agnz` delegates work to a locally-hosted LLM running as a sandboxed sub-agent. You drive it through the **`agnz` CLI** (invoked via Bash) — there is no MCP server. A sub-agent's intermediate tool calls do **not** consume your context; only its final summary comes back to you via the message hook.

## Invoking the CLI

Call the CLI with Bash. When the plugin is enabled, Claude Code adds its `bin/`
to your `PATH`, so `agnz` runs from any working directory — no path prefix or
`$CLAUDE_PLUGIN_ROOT` needed:

```bash
agnz <verb> [args...]
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
| `approve <id\|name> allow\|deny [--persist]` | Resolve an approval pause (no tool_call_id needed — the thread's pending call is used). Without `--persist` the approval is one-time; with it, a Bash command is remembered for the thread / another tool for the rest of the run. |
| `answer <id\|name> "answer text"` | Resolve an `AskUser` question pause. |
| `interrupt <id\|name> ["directive"]` | Hard interrupt a runaway/working agent: aborts the current step, leaves it resumable, optionally queues a directive. |
| `stop <id\|name>` | End and archive a thread (kills its runner; transcript persists on disk). |
| `remove <id\|name>` / `remove --status stopped\|error` | Delete a thread permanently — meta, transcript, trace, index entry. Live threads must be stopped first. |
| `show [<id\|name>] [--status <s>]` | The one inspection verb. No target: list all threads with judged `verdict`s. With a target: lean structural view — status, pending, spend, trace stats, `filesTouched`, no raw transcript. |
| `wait <id\|name> [--timeout <s>]` | Poll a detached run until it leaves `running`; prints the outcome (default timeout 300s; on timeout the phase-labelled `activity` triple tells generating from hung). |
| `mailbox [--from x] [--to x] [--kind k] [--limit n]` | Read-only peek into the message log — agent-to-agent traffic, consumed mail. Never advances your cursor. |

Runs are always detached — there is no `--wait` flag any more. To collect a result in the same call, poll with `agnz wait`; for long runs, launch it as a **background** Bash task (Claude Code: `run_in_background`) so the harness wakes you when the agent finishes. Timeout semantics, the phase-labelled `activity` liveness signal, and collect mode are covered in `references/lifecycle.md`.

## Resume, don't recreate

Threads are persistent. **`send <name>` reuses** the most recent live thread of that name instead of spawning a new one — so a follow-up keeps its context:

```bash
agnz show
agnz send researcher "Continue: now add the tests."
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
agnz start researcher-1 "Summarise how request logging works." --agent researcher
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
| `model` | no | profile name or `inherit`/`sonnet`/`haiku`/`opus` (mapped via the two-layer `config.json` — `/agnz:setup mapping`). |
| `tools` | no | JSON array whitelist → `allow`; others default to `ask`. |
| `disallowedTools` | no | JSON array blacklist → `deny` (overrides whitelist). |
| `skills` | no | JSON array allowlist for the `Skill` tool (default: all skills). |
| `temperature` / `maxTurns` | no | LLM overrides. |

## Team model

Sub-agents address each other by `name` via their `SendMessage` tool (`kind`: say/question/answer/handoff/status/error/directive). The recipient drains its inbox at its next turn. `to: "parent"` reaches you via the hook. All messages append to `<cwd>/.claude/agnz/messages.jsonl`.

## Concurrency

Each detached run is its own OS process, so multiple agents run in true parallel:

```bash
agnz start auth    "…" --agent researcher
agnz start billing "…" --agent researcher
```

## Reference files

- **`references/defining.md`** — full frontmatter spec and tool-policy model.
- **`references/lifecycle.md`** — background execution and team messaging in depth.
- **`references/orchestration.md`** — when to delegate, thread reuse, outcomes.
