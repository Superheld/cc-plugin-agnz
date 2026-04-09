---
name: orchestration
description: "This skill should be used when the user asks to 'use agnz', 'delegate to an agent', 'spawn an agent', 'run something with agnz', 'use the local model', 'have agnz do this', 'run agents in parallel', or when deciding whether to delegate a task to a sub-agent vs doing it directly. Covers routing decisions, picking the right agent, reading outcomes, and handling pauses."
---

# agnz orchestration — how to delegate effectively

Use this skill when you need to decide whether and how to delegate work to a sub-agent via agnz.

## The routing decision

**Delegate when:**
- Reading and summarising more than ~5 files — the sub-agent's intermediate reads stay out of your context
- Mechanical work: rename X everywhere, find all usages of Y, apply a pattern across many files
- Parallel work — you want two things done simultaneously and both are independent
- The task is self-contained enough that you can write a clear one-paragraph brief

**Do it yourself when:**
- One or two tool calls is all it takes — spawning an agent has overhead
- The task needs real-time judgment calls or user interaction mid-way
- You need the full reasoning chain in your own context to continue
- No profile is configured (check: does `~/.claude/agnz/profiles.json` exist and have an active profile?)

## Picking an agent

Before spawning, check whether the project has agent definitions:

```
Glob("<cwd>/.claude/agnz/agents/*.md")
```

Read the `description` field in each file's frontmatter. Pick the agent whose description best matches the task. A `researcher` for read/investigate tasks, an `editor` for write/refactor tasks, etc.

If there are no definitions, omit the `agent` parameter — the sub-agent runs with a generic prompt that covers all built-in tools.

## Spawning and sending

```
agent_start({ cwd: "<project-root>", agent: "<name-or-omit>" })
→ { thread_id: "abc123" }

agent_send({ thread_id: "abc123", message: "<your task brief>" })
→ { status: "final", content: "..." }
  | { status: "awaiting_input", kind: "approval" | "question", ... }
  | { status: "max_turns" }
```

Write the task brief as if briefing a capable colleague who cannot ask follow-up questions. Include: what to do, what to produce, any constraints (don't touch X, output format Y).

## Handling pauses

**Approval pause** (`kind: "approval"`): the sub-agent wants to run a gated tool (edit_file, write_file, bash). The return value tells you which tool and the arguments. Inspect, then:
- Allow once: `agent_approve({ thread_id, decision: "allow" })`
- Allow for the rest of the thread: `agent_approve({ thread_id, decision: "allow", persist: true })`
- Deny: `agent_approve({ thread_id, decision: "deny" })`

**Question pause** (`kind: "question"`): the sub-agent called `ask_user`. Read the question in the return value and answer with:
- `agent_answer({ thread_id, answer: "<your answer>" })`

## Reading outcomes

The return value of `agent_send` / `agent_wait` / `agent_approve` / `agent_answer` has a `content` field when `status: "final"`. That is the sub-agent's summary — use it directly. Do **not** read the full transcript unless you specifically need the detail (the transcript is at `<cwd>/.claude/agnz/threads/<thread_id>.jsonl`).

If `status: "max_turns"`, the agent ran out of turns before finishing. Read the last few lines of the transcript to see where it got to, then either re-send with a continuation message or handle what was completed so far.

## Parallel runs

```
// Start both, don't wait
agent_send({ thread_id: t1, message: "...", detach: true })
agent_send({ thread_id: t2, message: "...", detach: true })

// Wait for each
const r1 = await agent_wait({ thread_id: t1 })
const r2 = await agent_wait({ thread_id: t2 })
```

Both threads run concurrently. Each `agent_wait` blocks until that thread produces an event (final, pause, or error). Handle pauses for each independently.

## Workspace state at a glance

```
Read("<cwd>/.claude/agnz/workspace.json")              — members list, metadata
Read("<cwd>/.claude/agnz/threads/<id>.meta.json")      — status, pending, policy
Read("<cwd>/.claude/agnz/threads/<id>.jsonl")          — full transcript
Read("<cwd>/.claude/agnz/messages.jsonl")              — inter-agent messages
```

No MCP call needed to inspect state — all of it is plain files.
