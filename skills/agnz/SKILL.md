---
name: agnz
version: 0.3.0
user-invocable: false
description: "This skill should be used when the user asks to 'use agnz', 'delegate this to an agent', 'spawn an agent', 'resume a thread', 'continue with the agent', 'create an agent definition', 'write an agent file', 'define a role for the sub-agent', when agents should communicate or hand off work to each other, or when a task involves reading many files, bulk grep sweeps, or mechanical edits across multiple files where a local model can do the work. Also load when an agnz thread is paused and needs resolution via agent_approve or agent_answer, or when the user asks about running two agents in parallel."
---

# agnz agents

`agnz` delegates work to a locally-hosted LLM running as a sandboxed sub-agent. This skill covers:

1. **Thread identity** — threads are persistent; resume them, don't recreate.
2. **Defining** a named role — a `.md` file with identity, system prompt, and tool policy.
3. **Spawning** and talking to it via the `agent_*` MCP tools.
4. **Team model** — agents can address and hand off work to each other.

## When to delegate

A sub-agent's intermediate tool calls do **not** consume parent context — only its final summary comes back. Delegate when:

- The work is read-heavy (bulk file reads, grep sweeps)
- The work is mechanically repetitive (same edit pattern across many files)
- Two tasks can run in parallel (both return immediately, collect with `agent_wait`)

Avoid delegation when the work needs deep reasoning — local models are limited.

## Thread identity — resume, don't recreate

Every thread has a name, a purpose, and a persistent transcript. Before starting a new thread, check what's already there:

```
/agnz:threads list
```

If a thread for this task is `idle`, send to it directly — it already has context from earlier turns:

```
agent_send({ thread_id: "...", message: "Continue: now add the tests." })
```

Starting a fresh thread discards that context. Only create a new thread when the role or task is genuinely different from what exists.

Threads that are `stopped` or `error` cannot be resumed. Start a fresh thread in that case.

## Quick path — define and spawn

### Step 1 — create the agent file

Plugin-bundled agents (`dev`, `researcher`, `reviewer`, `general`) are available in every project. For project-specific roles create a file at `<cwd>/.claude/agents/<name>.md`:

```markdown
---
name: researcher
description: >
  Use this agent when the user asks to investigate code, find usages,
  or summarise a module.
model: inherit
disallowedTools: ["Edit", "Write", "Bash"]
---

Investigate code and produce concise, factual summaries.
Do not modify files. Finish with a one-paragraph summary.
```

### Step 2 — spawn

```
agent_start({ name: "researcher-1", agent: "researcher" })
→ { thread_id: "abc...", name: "researcher-1", agent: "researcher" }
```

`name` is the routing address for messages and for identifying the thread later.

### Step 3 — send a task

```
agent_send({ thread_id: "abc...", message: "Summarise how request logging works." })
→ { status: "final", content: "Request logging is handled by..." }
```

## Agent file — frontmatter fields

Agent files follow CC's native agent format. Fields:

| Field | Required | Notes |
|---|---|---|
| `name` | yes | `[a-z][a-z0-9_-]*`. Unique in the workspace. Also the mailbox address for messages. |
| `description` | yes | How Parent Claude picks this role. Plain prose or `>` block. Use `<example>` blocks for routing examples. |
| `model` | no | agnz profile name or `inherit`/`sonnet`/`haiku`/`opus` (mapped via workspace). Falls back to active profile if absent. |
| `color` | no | `blue`/`cyan`/`green`/`yellow`/`magenta`/`red`. |
| `tools` | no | JSON array — **whitelist**. Listed tools become `allow`; others default to `ask`. |
| `disallowedTools` | no | JSON array — **blacklist**. Overrides whitelist and profile. |
| `skills` | no | JSON array — allowlist for `Skill` tool. |
| `temperature` | no | LLM sampling temperature override. |
| `maxTurns` | no | Loop ceiling override. |

**Profile is the upper bound.** `tools:` can grant up to what the profile allows — it cannot unlock a tool the profile denies.

## The six MCP tools

| Tool | When |
|---|---|
| `agent_start` | Create a thread. Requires `name` (routing address) + `agent` (def name) or `inline` (frontmatter string). |
| `agent_send` | Send a task. Always returns immediately — agent runs in background. |
| `agent_approve` | Resolve an approval pause (sub-agent wants to run a gated tool). |
| `agent_answer` | Resolve a question pause (sub-agent called `AskUser`). |
| `agent_stop` | End a thread. Transcripts persist. |

**There is no `agent_status` or `agent_list_threads`.** Read `<cwd>/.claude/agnz/threads/*.meta.json` directly, or use `/agnz:threads list`.

### How results come back

Agents run entirely in the background. Results arrive via `SendMessage(to: "parent")` — the `UserPromptSubmit` hook injects unread parent mail into your next Claude prompt automatically. You don't poll; Claude tells you when there's something to read.

Pauses (approval / question) are signalled the same way (OS notification + hook injection). Resolve with `agent_approve` or `agent_answer` — both return immediately and the agent resumes in the background.

## Team model

Sub-agents address each other by the `name` given at `agent_start`. A researcher can hand off to a writer without going through the parent:

```
# Inside the researcher agent — tool call:
SendMessage({ to: "writer", kind: "handoff", body: "Investigation complete. Findings: ..." })
```

The writer drains its inbox at the start of its next turn and receives the message as a synthetic user message. No parent involvement needed.

Message kinds: `say`, `question`, `answer`, `handoff`, `status`, `error`, `directive`.

**Parent as recipient:** Agents can message the parent via `to: "parent"`. The `UserPromptSubmit` and `SessionStart` hooks (auto-enabled by the plugin) inject unread parent-addressed mail into Claude's context at the next prompt. Mark a message `urgent: true` to also trigger an OS notification.

**Reading the log:** All messages are appended to `<cwd>/.claude/agnz/messages.jsonl` — inspect it directly to see the full message history across agents.

## Concurrency

```
agent_start({name: "researcher-auth",  agent: "researcher"}) → thread_A
agent_start({name: "researcher-billing", agent: "researcher"}) → thread_B
agent_send({thread_id: A, message: "..."})
agent_send({thread_id: B, message: "..."})
```

Node's event loop gives real parallelism. Two agents finish in roughly the time one would take.

## Common pitfalls

- **Always creating new threads.** Check `/agnz:threads list` first. Resuming preserves context.
- **Vague description.** "Helper" routes nothing; "Read-heavy code investigation, no file writes" routes well.
- **Trying to expand tool policy from an agent def.** Only the profile can grant access. The agent def can only restrict.
- **Editing an agent file while a thread runs.** The thread uses a snapshot taken at `agent_start` — edits need a fresh thread.

## Reference files

- **`references/defining.md`** — full frontmatter spec, tool-policy merge model, example roles.
- **`references/lifecycle.md`** — full MCP tool signatures, background execution, team messaging in depth.
- **`references/orchestration.md`** — when to delegate, thread reuse, task briefing, handling outcomes.
