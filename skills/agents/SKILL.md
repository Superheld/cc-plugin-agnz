---
name: agents
version: 0.1.0
description: "This skill should be used when the user asks to 'use agnz', 'delegate work to a local model', 'should I use agnz for this', 'save tokens', 'offload this task', 'run this in the background', 'frontier quality not needed here', 'a reviewer will check this anyway', 'spawn a sub-agent', 'start a researcher agent', 'create an agent definition', 'write a researcher.md', 'run two sub-agents in parallel', 'approve a pending tool call', 'the agent is paused', or when a task is read-heavy, mechanical, or will be reviewed before use — making it a good candidate for a local model instead of a frontier model. Covers when and how to delegate, authoring agent-definition files, and the full sub-agent lifecycle including parallel runs and pause resolution."
---

# agnz agents

`agnz` delegates work to a locally-hosted LLM running as a sandboxed sub-agent. This skill covers two intertwined concerns:

1. **Defining** what a sub-agent *is* — its role, system prompt, and tool policy, stored as a markdown file with frontmatter under `<cwd>/.claude/agnz/agents/<name>.md`.
2. **Spawning** and holding a conversation with it via the MCP `agent_*` tools.

For setup (profiles, where files live, how to inspect workspace state) see the `workspace` skill.

## Why delegate at all

A sub-agent's intermediate tool calls (Read, Grep, Edit…) run inside its own loop and **do not consume parent context**. Only the final summary comes back. Delegate when:

- The work is read-heavy (bulk file reads, grep sweeps, "find everywhere X is used")
- The work is mechanically repetitive (same edit across many files, rename refactoring)
- Two investigations should run in parallel (sub-agents are concurrent via `detach: true`)

Avoid delegation when the work needs deep reasoning — local models are useful but limited.

## Quick path — define and spawn

**Step 1: define a role.** Create `<cwd>/.claude/agnz/agents/researcher.md`:

```markdown
---
name: researcher
profile: lmstudio-devstral
description: >
  Read-heavy code investigation. Bulk reads, grep sweeps, summaries.
tools:
  edit_file: deny
  write_file: deny
---

You are a research sub-agent. Investigate code and produce concise,
factual summaries. You do not modify files. When you finish, reply
with a one-paragraph summary of what you found.
```

**Step 2: spawn.** Call `agent_start` with `agent: "researcher"`:

```
agent_start({ cwd: "/abs/path", agent: "researcher" })
  → { thread_id: "abc...", profile: "lmstudio-devstral", policy: {...}, agent: "researcher" }
```

**Step 3: send a task.** Sync by default — blocks until done or paused:

```
agent_send({ thread_id: "abc...", message: "Summarize how request logging works in this repo." })
  → { status: "final", content: "Request logging is handled by...", ... }
```

That's it for the happy path. The sections below cover the details.

## Defining an agent role

Full field reference, policy-merge rules, and several example definitions (researcher / editor / tester) are in [references/defining.md](references/defining.md). Consult that when creating a new role or debugging why a role's effective policy looks wrong.

The single most important rule to remember inline: **the profile is the upper bound of the tool policy.** An agent definition can only *restrict* further — if the profile says `edit_file: ask` and the agent says `edit_file: allow`, the effective decision is still `ask` (strictest wins, deny > ask > allow). The `workspace` skill's reference has the profile side; [references/defining.md](references/defining.md) has the agent side.

## Holding a conversation — the lifecycle

`agnz` exposes six MCP tools, all prefixed `agent_`:

| Tool | When |
|---|---|
| `agent_start` | Create a thread locked to a cwd. Returns a `thread_id`. |
| `agent_send` | Give the sub-agent a task or a follow-up. Sync by default. |
| `agent_approve` | Resolve an approval pause (sub-agent wants to run a gated tool). |
| `agent_answer` | Resolve a question pause (sub-agent called `ask_user`). |
| `agent_wait` | Block for the next event on a detached thread. |
| `agent_stop` | End a live thread. Transcripts persist. |

**There is no `agent_status` or `agent_list_threads`.** To check current state, `Read` the files under `<cwd>/.claude/agnz/threads/` directly — the `workspace` skill shows the layout.

### The three outcomes of a send

Any `agent_send` / `agent_approve` / `agent_answer` call returns one of:

1. **`status: "final"`** — the sub-agent finished its turn with a plain text answer. The round is over.
2. **`status: "awaiting_input"`, `kind: "approval"`** — the sub-agent wants to run a tool whose policy is `ask` (typically `edit_file` or `write_file`). Resolve with `agent_approve(thread_id, tool_call_id, decision: "allow"|"deny", persist?: true)`. Setting `persist: true` upgrades the tool to `allow` for the rest of the thread, avoiding repeated pauses on every subsequent edit.
3. **`status: "awaiting_input"`, `kind: "question"`** — the sub-agent called `ask_user` because it genuinely cannot decide on its own. Resolve with `agent_answer(thread_id, tool_call_id, answer: "...")`.

Both pause kinds block the sub-agent until resolution. There is no timeout — a paused thread stays paused indefinitely.

For the full lifecycle including error recovery, the `detach` + `agent_wait` concurrency pattern, and how messages/mailboxes fit in, see [references/lifecycle.md](references/lifecycle.md).

## Concurrency — running two sub-agents at once

```
agent_start A → thread_A
agent_start B → thread_B
agent_send(A, task, detach: true)
agent_send(B, task, detach: true)
agent_wait(A) → outcome_A
agent_wait(B) → outcome_B
```

Node's event loop gives real parallelism while the sub-agents await their respective LLM endpoints. Two agents finish in roughly the time one would take. Patterns and trade-offs in [references/lifecycle.md](references/lifecycle.md).

## Common pitfalls

- **Vague `description` on an agent definition.** It is *the* field Parent Claude uses to decide which role to spawn for which task. "Helper agent" routes nothing; "Read-heavy code investigation; bulk reads, grep sweeps, summaries of large modules" routes well.
- **Assuming the agent def can unlock a tool.** It cannot. Upgrade the profile to enable more capabilities.
- **Editing an agent file while a thread is running.** The thread keeps the definition it was spawned under (snapshotted on start) — start a fresh thread to pick up the new version.
- **Using MCP calls to poll state.** Read the files directly with Read/Glob/Grep. The MCP surface is intentionally small.

## Additional resources

- **[references/defining.md](references/defining.md)** — full frontmatter field reference, the tool-policy merge model with worked examples, and three complete example roles (researcher, editor, tester).
- **[references/lifecycle.md](references/lifecycle.md)** — full MCP tool reference (all six tools with signatures), the three-outcomes model in depth, the detach + wait concurrency pattern, error recovery, and agent-to-agent messaging via `send_message` and `messages.jsonl`.
- **[references/orchestration.md](references/orchestration.md)** — when to delegate vs. do it yourself, how to pick an agent, how to write a task brief, handling outcomes and pauses, parallel runs.
