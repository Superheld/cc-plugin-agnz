# ADR 0007: Parent context — how Claude sees and uses the workspace

- **Status:** Proposed (roadmap)
- **Date:** 2026-04-09
- **Depends on:** [ADR 0001](./0001-workspace-first-architecture.md), [ADR 0002](./0002-communication-mailbox-and-events.md), [ADR 0003](./0003-agent-definitions.md)

## Context

For agnz to work well, the parent Claude session needs a clear, up-to-date picture of the workspace: which agents exist, what they can do, what is currently running, what the board looks like. Today this picture is assembled ad-hoc — Claude reads files when it happens to think of it, and there is no systematic way to ensure Claude knows the workspace state before acting.

The parent Claude also needs to know *when* and *how* to use agnz at all: when is it worth spawning an agent vs. doing the work directly? Which agent fits which task? How do you read a thread's outcome without losing context? This guidance currently lives only in the plugin's `INSTRUCTIONS` field (minimal) and in `CLAUDE.md` (aimed at developers, not users).

This ADR covers how we give the parent Claude a complete, reliable context for working with agnz — without requiring Claude to re-read the same files from scratch every session.

## Decision

### 1. Three layers of parent context

**Layer 1 — Static: plugin-level skills**

The plugin ships skills that tell the parent how to use agnz. These are loaded on demand (the parent calls `use_skill` when it needs guidance) and cover:

- `workspace` — the current data layout, how to read workspace state (already exists, ships with the plugin)
- `agents` — how to define, spawn, and communicate with agents (already exists)
- `orchestration` — when to delegate vs. do work directly; how to route tasks to agents by role; how to read outcomes without bloating context; how to handle pauses and approvals efficiently

The `orchestration` skill is the most important and does not exist yet. It answers the question Claude must ask before every task: "should I do this myself, or delegate to an agent?"

**Layer 2 — Dynamic: workspace state injected at session/prompt time**

The `SessionStart` and `UserPromptSubmit` hooks (ADR 0002) already inject unread messages from the workspace. This ADR extends that injection to include a **workspace summary** when the workspace is active:

- Active threads: name, status, last activity
- Board state (ADR 0004): items in progress and their owners
- Any agents defined in `.claude/agnz/agents/` — name and description

This summary is compact (a few lines per item) and tells Claude what the team is doing *right now* without requiring a manual `Read` of every file. The hook only injects when the workspace exists and has meaningful state — an idle or non-existent workspace produces no output.

**Layer 3 — Instructions: MCP INSTRUCTIONS field**

The `INSTRUCTIONS` field on the agnz MCP server (returned in `initialize`) is what CC injects into Claude's system prompt when the plugin is connected. Today it is a minimal "what tools are available" blurb. This ADR upgrades it to a concise decision guide:

- When to use agnz (read-heavy work, parallel runs, tasks that should not consume parent context)
- When not to use agnz (quick one-liners, tasks that need real-time interaction with the user)
- The core workflow: start → send → read outcome from files, not from MCP
- How to pick an agent: read `.claude/agnz/agents/` descriptions

The INSTRUCTIONS field is always present (no opt-in required), so every session with agnz connected gets the baseline guidance automatically.

### 2. The orchestration skill in detail

The most important guidance for the parent is the routing decision. The skill should make this concrete:

```
When to delegate to an agent:
- Reading and summarising more than ~5 files
- Tasks that are mechanical and don't need your reasoning (rename X everywhere, find all usages of Y)
- Tasks you want to run in parallel with other work
- Tasks where intermediate tool calls would bloat your context window

When to do it yourself:
- The task needs real-time user interaction
- You need to make judgment calls that require your full context
- The task is a single file read or a trivial edit
- No agent is configured for this project
```

The skill is not prescriptive — Claude still decides. But explicit heuristics are more actionable than "use agnz when helpful."

### 3. What we are NOT building in this ADR

- **Automatic task routing.** Claude decides what to delegate. We provide guidance and context, not automation.
- **A dedicated "orchestrator" agent.** The parent Claude is the orchestrator. Sub-agents are workers.
- **Real-time workspace state in the system prompt.** The hook injection at prompt-submit time is close enough to real-time for the conversation cadence. True real-time would require pushing state changes mid-reply, which is not possible in CC today.

## Deferred / Open questions

- **Context compression interaction.** When CC compresses the parent's conversation, the workspace summary may be compressed away. The next `UserPromptSubmit` hook will re-inject it, but there may be a turn where Claude answers without the current workspace state. Acceptable in V1.
- **Multi-workspace sessions.** If the user works in two projects simultaneously, the hook injects state for both. The summary format should make it clear which workspace each item belongs to.
