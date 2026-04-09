---
name: agents
version: 0.2.0
description: "This skill should be used when the user asks to 'use agnz', 'delegate this to an agent', 'spawn an agent', 'create an agent definition', 'write an agent file', 'define a role for the sub-agent', or when a task involves reading many files, bulk grep sweeps, or mechanical edits across multiple files where a local model can do the work. Also load when an agnz thread is paused and needs resolution via agent_approve or agent_answer, or when the user asks about running two agents in parallel."
---

# agnz agents

`agnz` delegates work to a locally-hosted LLM running as a sandboxed sub-agent. This skill covers:

1. **Defining** a named role — a `.md` file that gives the sub-agent its identity, system prompt, and tool policy.
2. **Spawning** and talking to it via the `agent_*` MCP tools.

For setup (profiles, data paths) see the `workspace` skill.

## When to delegate

A sub-agent's intermediate tool calls do **not** consume parent context — only its final summary comes back. Delegate when:

- The work is read-heavy (bulk file reads, grep sweeps)
- The work is mechanically repetitive (same edit pattern across many files)
- Two tasks can run in parallel (`detach: true`)

Avoid delegation when the work needs deep reasoning — local models are limited.

## Quick path — define and spawn

### Step 1 — create the agent file

Agent files live at:
```
<cwd>/.claude/agnz/agents/<name>.md
```

Minimal example — create `<cwd>/.claude/agnz/agents/researcher.md`:

```markdown
---
name: researcher
description: |
  Use this agent when the user asks to investigate code, find usages,
  or summarise a module. Examples:

  <example>
  Context: User wants to understand the codebase.
  user: "How does request logging work?"
  assistant: "I'll delegate this to the researcher agent."
  <commentary>Read-heavy, no edits needed.</commentary>
  </example>
model: lmstudio-devstral
color: blue
disallowedTools:
  - edit_file
  - write_file
---

Investigate code and produce concise, factual summaries.
Do not modify files. Finish with a one-paragraph summary.
```

### Step 2 — spawn

```
agent_start({ cwd: "/abs/path/to/project", agent: "researcher" })
→ { thread_id: "abc...", profile: "lmstudio-devstral", policy: {...} }
```

### Step 3 — send a task

```
agent_send({ thread_id: "abc...", message: "Summarise how request logging works." })
→ { status: "final", content: "Request logging is handled by..." }
```

## Agent file — frontmatter fields

agnz agent files follow the same format as CC's built-in agent definitions. The main difference is `tools`: CC uses an array of names to grant access; agnz uses a policy map `{toolName: allow|ask|deny}`.

| Field | Required | Notes |
|---|---|---|
| `name` | yes | `[a-z][a-z0-9_-]*`. Unique in the workspace. |
| `description` | yes | How Parent Claude picks this role. Use `\|` for multi-line with `<example>` blocks. **Be specific.** |
| `model` | no | agnz profile name (e.g. `lmstudio-devstral`). Falls back to active profile if absent. |
| `color` | no | `blue`/`cyan`/`green`/`yellow`/`magenta`/`red`. Stored for future UI use. |
| `tools` | no | String array — **whitelist**. Only listed tools are available; all others denied. Profile is the upper bound. |
| `disallowedTools` | no | String array — **blacklist**. Listed tools are denied, overrides the whitelist. |
| `skills` | no | String array — allowlist for `use_skill`. Absent = all project-local skills available. |
| `temperature` | no | LLM sampling temperature override. |
| `maxTurns` | no | Loop ceiling override. |

**Critical rule:** The profile's `defaultPolicy` is the ceiling. Listing a tool in `tools` can never promote it beyond the profile's decision. To unlock a tool, update the profile.

## The six MCP tools

| Tool | When |
|---|---|
| `agent_start` | Create a thread. Returns `thread_id`. |
| `agent_send` | Send a task. Sync by default — blocks until done or paused. |
| `agent_approve` | Resolve an approval pause (sub-agent wants to run a gated tool). |
| `agent_answer` | Resolve a question pause (sub-agent called `ask_user`). |
| `agent_wait` | Block for the next event on a detached thread. |
| `agent_stop` | End a thread. Transcripts persist. |

**There is no `agent_status` or `agent_list_threads`.** Read `<cwd>/.claude/agnz/threads/*.meta.json` directly.

### The three outcomes of agent_send

1. **`status: "final"`** — sub-agent finished. Round is over.
2. **`status: "awaiting_input"`, `kind: "approval"`** — sub-agent wants to run a gated tool. Resolve with `agent_approve(thread_id, tool_call_id, decision: "allow"|"deny", persist?: true)`. Use `persist: true` to avoid repeated pauses for the same tool.
3. **`status: "awaiting_input"`, `kind: "question"`** — sub-agent called `ask_user`. Resolve with `agent_answer(thread_id, tool_call_id, answer: "...")`.

## Concurrency

```
agent_start A → thread_A
agent_start B → thread_B
agent_send(A, task, detach: true)
agent_send(B, task, detach: true)
agent_wait(A) → outcome_A
agent_wait(B) → outcome_B
```

Node's event loop gives real parallelism. Two agents finish in roughly the time one would take.

## Common pitfalls

- **Vague description.** The description is how the right role gets picked. "Helper" routes nothing; "Read-heavy code investigation, no file writes" routes well.
- **Trying to expand tool policy from an agent def.** Only the profile can grant access. The agent def can only restrict.
- **Editing an agent file while a thread runs.** The thread uses a snapshot taken at `agent_start` — edits need a fresh thread.

## Reference files

For deeper content, read the file using the base directory shown in the skill header:

- **`references/defining.md`** — full frontmatter spec, the tool-policy merge model with worked examples, three complete example roles (researcher / editor / tester), snapshot-on-spawn semantics.
- **`references/lifecycle.md`** — full MCP tool signatures, error recovery, the detach + wait pattern in depth, agent-to-agent messaging via `send_message`.
- **`references/orchestration.md`** — when to delegate vs. do it yourself, how to write a task brief, handling outcomes and pauses, parallel run patterns.
