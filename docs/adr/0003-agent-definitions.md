# ADR 0003: Agent definitions — roles on top of profiles

- **Status:** Proposed
- **Date:** 2026-04-08
- **Branch:** `refactor/workspace-first-architecture`
- **Depends on:** [ADR 0001](./0001-workspace-first-architecture.md), [ADR 0002](./0002-communication-mailbox-and-events.md)

## Context

Today, an agnz "sub-agent" is parameterised entirely by a *profile*: `{baseUrl, apiKey, model, temperature, defaultPolicy, ...}`. A profile describes an **endpoint** — where the LLM lives and what its raw behaviour is. It does not describe what the agent *is for*: its role, its specialisation, its system prompt, whether it is allowed to write files, how it should communicate.

That conflation was fine when agnz had one sub-agent at a time. Once we have a workspace that is a team — a researcher alongside an editor alongside a tester, each potentially using a different local model — we need a layer above profiles. A researcher on Devstral and an editor on Devstral both use the same endpoint but should behave very differently. The same researcher, tomorrow, might move to Qwen without any change to its role, prompt, or tool policy.

We also want the team to feel like Claude Code's native agent system without *being* that system. Claude Code's subagent mechanism (`general-purpose`, `Explore`, user-defined agents under `.claude/agents/*.md`) is Anthropic-model-only; it cannot route to a local endpoint. agnz is the parallel system that does exactly that. It should borrow the ergonomics: markdown files with YAML frontmatter, one agent per file, a natural directory to drop them in.

## Decision

Agent definitions are **files** in the project workspace, separate from profiles, and referenced by name.

### 1. Location

```
<cwd>/.claude/agnz/agents/
├── researcher.md
├── editor.md
└── tester.md
```

Per-project only. No user-wide fallback — if you want a library of reusable agents, version them in a template repo and copy them in. This is a deliberate choice to keep agents tightly coupled to the project they serve, matching how a team's roles are shaped by the work they are hired to do.

### 2. File format: Markdown with YAML frontmatter

```markdown
---
name: researcher
profile: lmstudio-devstral
description: >
  Read-heavy code investigation. Good for bulk reads, grep sweeps,
  "find everywhere X is used", summaries of large modules.
tools:
  list_dir: allow
  read_file: allow
  grep: allow
  edit_file: deny
  write_file: deny
  ask_user: allow
  send_message: allow
---

You are a research sub-agent in the agnz workspace. Your role is to
investigate code: read files, search for patterns, and produce concise,
factual summaries. You do not modify files.

When you take on an item, post a brief `status` message with your plan.
When you finish, write your findings into the item's `notes` and move it
to `review` — the parent signs off on `done`.

If you need information you cannot determine from the code alone, use
`ask_user`. If another agent's work would help, send them a `handoff`
message.
```

**Frontmatter fields:**

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Unique within the workspace. Lowercase, `[a-z][a-z0-9_-]*`. |
| `profile` | yes | Name of an existing profile in the user-wide profile store. |
| `description` | yes | One or two sentences. Used by the parent (Claude) to pick which agent to spawn for which task. |
| `tools` | no | Per-tool policy overrides. Keys are tool names, values are `allow` / `ask` / `deny`. Missing tools inherit from the profile's `defaultPolicy`. |
| `temperature` | no | Override the profile's temperature for this role. |
| `maxTurns` | no | Override the profile's `maxTurns`. |
| `reviewRequired` | no | `true` (default) means items worked on by this agent must go through `review` before `done`; `false` allows the agent to close items itself. Planned for integration with the board (ADR 0004). |

**Markdown body = the system prompt.** The entire body below the frontmatter is concatenated with the default agnz system prompt (sandbox rules, tool discipline, mailbox instructions) to form the sub-agent's final system message. This keeps the role's voice in one place and lets you write it in actual prose with examples and formatting.

### 3. Profile versus agent definition

Clear separation of concerns:

| Aspect | Profile | Agent definition |
|---|---|---|
| Defines | The endpoint and raw model behaviour | The role, voice, and permissions |
| Scope | User-wide (shared across projects) | Per-project (lives with the code) |
| Answers | "Where does the LLM live? What model? How hot?" | "What is this agent's job? What can it do? What is its voice?" |
| Versioned | No (user config) | Yes (committed with the project, if the user wants) |
| Count | A handful, stable | As many as the project needs, evolves with it |

**An agent definition references a profile by name.** Changing the profile in the file re-points the agent at a different endpoint without touching its role. This is the answer to "how do I swap my researcher from Devstral to Ollama-hosted Mistral?" — edit one line.

### 4. Loading

Agent definitions are loaded **lazily, at thread-start time**:

1. `agent_start(cwd, agent: "researcher")` or `/agnz:spawn researcher "task"`.
2. The server resolves `<cwd>/.claude/agnz/agents/researcher.md`.
3. Parses frontmatter + body. Validates schema (name present, profile resolvable, tools keys known).
4. Looks up the referenced profile in the user-wide profile store.
5. Merges: profile's `defaultPolicy` is the base; agent's `tools` field overrides per key. Other fields (temperature, maxTurns) override the profile's values when present.
6. System prompt for the sub-agent: `[base agnz system prompt] + [agent.body]`.
7. Thread meta stores a **snapshot** of the resolved agent definition, not just the file path. This is important because:
   - The file may be edited after the thread starts. We want the thread to continue with the definition it was spawned under, not drift mid-run.
   - The thread can be inspected after completion to understand exactly how the agent was configured.

An `agent` parameter on `agent_start` is new in this ADR. The existing `profile` parameter remains and can be used without an agent definition — in that case the sub-agent runs as the "default unnamed agent" with the base system prompt only. This preserves the v0.3.0 workflow.

### 5. Tool policy: profile is the upper bound

An agent definition's `tools` map may **restrict** but not **expand** what the profile allows:

- If the profile says `edit_file: ask` and the agent says `edit_file: deny`, the agent cannot edit files. Deny wins.
- If the profile says `edit_file: deny` and the agent says `edit_file: allow`, the agent **cannot** edit files. The deny stands.
- The effective policy for tool T is `strictest(profile[T], agent[T])`, where `deny > ask > allow`.

This is deliberate. The profile is the user's trust setting for the endpoint (what can this model's process touch at all?), and an agent role is only ever a further narrowing of that. If you want a more powerful agent, you upgrade the profile.

**Implication for the `defaultPolicy` shown in profiles today:** it remains the upper bound. The `agent_start` handler computes the effective policy from both sources and hands it to the sandbox.

### 6. Concurrency and naming

- **Agent definitions are stateless.** Multiple threads can run the same agent definition simultaneously — e.g. two `researcher` threads working on different items. They each get their own thread meta, their own inbox, their own sandbox.
- **Recipient addressing** in messages (ADR 0002) uses `from` / `to` fields that refer to **thread identifiers**, not agent names. Two researchers are `researcher#abc123` and `researcher#def456` at the mailbox level. A message `to: "researcher"` is ambiguous and rejected by the bus — the sender must specify which one, or broadcast to all with a role-based filter (deferred).
- **In user-facing UI** (slash commands, board display, logs), we show `<name>:<short-id>` so the user can tell instances apart without needing to type full IDs.

### 7. What the parent (Claude) does with this

The parent uses agent definitions to make *routing decisions*:

1. User asks for a task.
2. Claude reads `<cwd>/.claude/agnz/agents/*.md` (via normal `Read` + `Glob`, not MCP).
3. Sees the `description` fields, picks the agent whose description matches the task best.
4. Calls `agent_start(cwd, agent: <name>)` to spawn it.
5. Calls `agent_send(thread_id, "<task>")` to kick it off.

The `description` is load-bearing for this — it is the one field Claude consults to decide which agent is right for a job. Agents with vague descriptions get picked for the wrong work. This is the single most important field in the file after `name` and `profile`, and it should be written specifically enough that Claude can tell two agents apart.

### 8. What we are not building in this ADR

- **No built-in agent library.** The plugin ships with zero agents. The user creates their own (or copies from a starter template that we may offer separately, outside the plugin, as documentation).
- **No inheritance between agents.** If you want a `senior-researcher` that extends `researcher` with a different prompt, copy the file and change what you need. Inheritance adds complexity that is rarely worth it at this size.
- **No runtime reload.** Editing an agent file mid-thread does not affect the running thread. Only newly-started threads see the new definition.
- **No team composition files.** There is no `.claude/agnz/teams/<name>.md` listing which agents a team uses. A team is simply "all agents you have spawned in this workspace." If we later find team composition useful, it becomes its own ADR.

## Consequences

### Positive

- **Clean separation of "where" and "what."** Swapping endpoints does not disturb roles. Editing roles does not risk the endpoint.
- **Agent files are reviewable and versionable.** They live with the project, they are plain text with prose system prompts, they diff cleanly. The same way you would review a PR that changes a prompt in a Python app, you can review changes to an agent definition.
- **Ergonomic parity with Claude Code's native agents.** Users who know CC's `.claude/agents/*.md` feel instantly at home with our format. We deliberately mirror the shape.
- **Parent routing is data-driven, not hard-coded.** Claude picks agents by reading the files, not by having them burned into its own knowledge. Add a new agent file and Claude can use it immediately, without any plugin update.
- **Profiles stay simple.** We resist the temptation to pack "roles" into profiles. Profile stays a pure endpoint description.

### Negative

- **Description quality matters.** A sloppy `description` field leads to Claude picking the wrong agent. This is a user-education concern, not a code concern, but it is real.
- **Per-project only means no sharing.** A user who builds up a great `researcher` agent for project A has to copy the file to project B manually. We accept this in exchange for simplicity; a future ADR could add a user-wide fallback or a "copy from other project" slash command.
- **The tool policy model has an asymmetry users may not expect.** "I added `edit_file: allow` to my agent but it still can't edit files" — because the profile denies it. The `/agnz:setup` tool should surface this clearly in the test/ping output. Documentation must call it out.
- **Snapshot-on-spawn means stale agents keep running.** If you fix a bug in your researcher's system prompt, currently-running researchers keep the old prompt until they finish. This is a feature (stability mid-run) but can confuse users who expect live editing.

### Neutral

- **Built-in library opt-out.** We chose to ship no defaults. This means first-time users face an empty `agents/` directory. The onboarding flow (readme, `/agnz:setup` docs, example files in the repo *outside* the plugin proper) must compensate.

## Deferred / Open questions

- **Role-based recipients in messages.** `to: "role:researcher"` would fan out to all active researchers. Useful, but we need to see if multi-instance roles actually happen before committing to the routing logic.
- **User-wide agent library with per-project override.** Analogous to how profiles work today. Nice but not urgent — add it when a user actually wants cross-project agents.
- **Hot-reload of agent definitions.** A `/agnz:reload-agent <name>` slash command that refreshes a thread's system prompt without restarting. Sharp edge: changes the contract mid-run. Only add if people ask.
- **Agent capabilities beyond tools.** e.g. "this agent can spawn sub-agents of its own", "this agent owns these board columns". These start feeling like permissions-on-permissions. Defer until concrete demand exists.
- **Encrypted / secret fields.** If an agent needs a dedicated API key (e.g. a hosted endpoint separate from the profile's default), where does that key live? For now: use a dedicated profile. Keys do not go in agent definitions.

## Interaction with ADR 0001 and 0002

ADR 0001 established the workspace directory. This ADR adds:

```
<cwd>/.claude/agnz/
├── workspace.json
├── messages.jsonl                 (0002)
├── cursors/                       (0002)
├── agents/                        ← NEW: this ADR
│   ├── researcher.md
│   └── ...
├── threads/
│   └── <id>.meta.json             ← extended: `agent` snapshot field
└── scratch/
```

ADR 0002's messaging schema uses `from` / `to` fields that refer to *thread identifiers* (e.g. `researcher#abc123`), not raw agent names. That decision is finalised here — it was previously ambiguous because agent names were not clearly scoped.

ADR 0004 (board) will refer to `owner: <agent-name-or-thread-id>`. Owners can be addressed by *role name* (for items in backlog/planned, where no specific instance has picked them up yet) or by *thread id* (for items in progress, where a specific instance owns the work). The precise rules belong in 0004.
