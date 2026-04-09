# ADR 0003: Agent definitions — roles on top of profiles

- **Status:** Active (living document)
- **Date:** 2026-04-08
- **Updated:** 2026-04-09
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
profile: lmstudio
description: >
  Read-heavy code investigation. Good for bulk reads, grep sweeps,
  "find everywhere X is used", summaries of large modules.
tools:
  - Read
  - Grep
  - LS
  - AskUser
  - SendMessage
disallowedTools:
  - Edit
  - Write
  - Bash
skills:
  - code-navigation
maxTurns: 40
---

You are a research sub-agent in the agnz workspace. Your role is to
investigate code: read files, search for patterns, and produce concise,
factual summaries. You do not modify files.

When you take on an item, post a brief `status` message with your plan.
When you finish, write your findings into the item's `notes` and move it
to `review` — the parent signs off on `done`.

If you need information you cannot determine from the code alone, use
`AskUser`. If another agent's work would help, send them a `handoff`
message.
```

**Frontmatter fields:**

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Unique within the workspace. Lowercase, `[a-z][a-z0-9-]*`. |
| `profile` | yes | Name of an existing profile in the user-wide profile store. |
| `description` | yes | One or two sentences. Used by the parent (Claude) to pick which agent to spawn for which task. |
| `tools` | no | Explicit allowlist of tool names (PascalCase: `Read`, `Grep`, `LS`, `Edit`, `Write`, `Bash`, `AskUser`, `SendMessage`, `Skill`). If set, only listed tools are available. |
| `disallowedTools` | no | Explicit denylist. Applied on top of the profile's defaultPolicy. |
| `skills` | no | List of skill names the agent may load on demand from `<cwd>/.claude/skills/<name>/SKILL.md`. A catalog is injected into the system prompt at startup (see ADR 0006). |
| `temperature` | no | Override the profile's temperature for this role. |
| `maxTurns` | no | Override the profile's `maxTurns`. |

Tool names are **PascalCase** matching Claude Code's built-in tool naming, so agent definition files can be shared between CC and agnz without modification.

**Markdown body = the system prompt.** The entire body below the frontmatter is concatenated with the default agnz system prompt (sandbox rules, tool discipline, mailbox instructions) to form the sub-agent's final system message.

### 3. Profile versus agent definition

Clear separation of concerns:

| Aspect | Profile | Agent definition |
|---|---|---|
| Defines | The endpoint and raw model behaviour | The role, voice, and permissions |
| Scope | User-wide (shared across projects) | Per-project (lives with the code) |
| Answers | "Where does the LLM live? What model? How hot?" | "What is this agent's job? What can it do? What is its voice?" |
| Versioned | No (user config) | Yes (committed with the project, if the user wants) |
| Count | A handful, stable | As many as the project needs, evolves with it |

**An agent definition references a profile by name.** Changing the profile in the file re-points the agent at a different endpoint without touching its role. This is the answer to "how do I swap my researcher from Devstral to Qwen?" — edit one line.

### 4. Loading

Agent definitions are loaded **lazily, at thread-start time**:

1. `agent_start(cwd, agent: "researcher")`.
2. The server resolves `<cwd>/.claude/agnz/agents/researcher.md`.
3. Parses frontmatter + body. Validates schema (name present, profile resolvable, tools keys known).
4. Looks up the referenced profile in the user-wide profile store.
5. Merges: profile's `defaultPolicy` is the base; agent's `tools`/`disallowedTools` override per key. Other fields (temperature, maxTurns) override the profile's values when present.
6. System prompt for the sub-agent: `[base agnz system prompt] + [skills catalog if skills: is set] + [agent.body]`.
7. Thread meta stores a **snapshot** of the resolved agent definition, not just the file path — the thread continues with the definition it was spawned under regardless of later edits to the file.

### 5. Tool policy: profile is the upper bound

An agent definition's tool lists may **restrict** but not **expand** what the profile allows:

- If the profile says `Edit: ask` and the agent has `Edit` in `disallowedTools`, the agent cannot edit files. Deny wins.
- If the profile says `Edit: deny` and the agent has `Edit` in `tools`, the agent **cannot** edit files. The deny stands.
- The effective policy for tool T is `strictest(profile[T], agent[T])`, where `deny > ask > allow`.

This is deliberate. The profile is the user's trust setting for the endpoint (what can this model's process touch at all?), and an agent role is only ever a further narrowing of that.

### 6. Concurrency and naming

- **Agent definitions are stateless.** Multiple threads can run the same agent definition simultaneously.
- **Recipient addressing** in messages (ADR 0002) uses thread identifiers, not agent names. Two researchers are `researcher#abc123` and `researcher#def456` at the mailbox level.
- **In user-facing UI**, we show `<name>:<short-id>` so the user can tell instances apart.

### 7. What the parent (Claude) does with this

1. User asks for a task.
2. Claude reads `<cwd>/.claude/agnz/agents/*.md` (via normal `Read` + `Glob`, not MCP).
3. Sees the `description` fields, picks the agent whose description matches the task best.
4. Calls `agent_start(cwd, agent: <name>)` to spawn it.
5. Calls `agent_send(thread_id, "<task>")` to kick it off.

The `description` is the single most important field for routing decisions — write it specifically enough that Claude can tell two agents apart.

### 8. What we are not building in this ADR

- **No built-in agent library.** The plugin ships with zero agents.
- **No inheritance between agents.** Copy and modify if you need variants.
- **No runtime reload.** Editing an agent file mid-thread does not affect the running thread.
- **No team composition files.** A team is all agents you have spawned in the workspace.

## Consequences

### Positive

- **Clean separation of "where" and "what."** Swapping endpoints does not disturb roles.
- **Agent files are reviewable and versionable.** Plain text, diff cleanly.
- **Ergonomic parity with Claude Code's native agents.** Users who know CC's `.claude/agents/*.md` feel instantly at home.
- **Parent routing is data-driven, not hard-coded.** Add a new agent file and Claude can use it immediately.
- **Profiles stay simple.** Pure endpoint description.

### Negative

- **Description quality matters.** A sloppy `description` leads to Claude picking the wrong agent.
- **Per-project only means no sharing.** A great `researcher` for project A must be copied to project B manually.
- **The tool policy asymmetry can confuse users.** "I added `Edit` to `tools:` but it still can't edit files" — because the profile denies it. Documentation must call this out clearly.
- **Snapshot-on-spawn means stale agents keep running.** Fixing a bug in a running agent's prompt only takes effect for newly-spawned threads.

## Interaction with ADR 0001 and 0002

ADR 0001 established the workspace directory. This ADR adds:

```
<cwd>/.claude/agnz/
├── workspace.json
├── messages.jsonl                 (0002)
├── cursors/                       (0002)
├── agents/                        ← this ADR
│   ├── researcher.md
│   └── ...
├── threads/
│   └── <id>.meta.json             ← extended: `agentDef` snapshot field
└── scratch/
```

---

## Roadmap — open ideas (no decisions yet)

This section collects directions we are considering but have not decided on. All items are open for discussion.

### Model selection per agent

Currently a profile has exactly one `model`. The idea: add an optional `model:` field to the agent definition that overrides the profile's model for that role.

```yaml
model: qwen3-4b   # overrides profile.model for this agent
```

Fallback chain: `agentDef.model` → `profile.model`. If LM Studio doesn't serve the requested model, the endpoint returns an error — natural signal.

Why this matters: when running multiple smaller models in LM Studio simultaneously (possible when context windows are not maxed out), different agents could use different models matched to their task complexity — a small fast model for read-only research, a larger one for code generation.

Open question: should model selection live in the agent def at all, or should we introduce "model profiles" (endpoint + model pairs) and keep agent defs model-agnostic? Keeping them model-agnostic preserves the profile-as-ceiling property and means swapping hardware requires touching only profiles.

Further idea: support CC's model identifiers (`inherit`, `sonnet`, `opus`, `haiku`) as symbolic aliases. agnz would map them to the corresponding model string configured in the active profile (e.g. `haiku` → `qwen3-4b` as the "fast/cheap" slot, `sonnet` → `devstral` as the "capable" slot). This mapping would live in the profile. Agent def files written for CC agents could then be copied into agnz without modification — the model field stays valid in both systems.

### Profile refactoring

As agents grow more expressive, the `defaultPolicy` inside profiles may become redundant. If every meaningful use of agnz goes through an agent def with explicit `tools:`/`disallowedTools:`, the profile policy is only ever consulted for undecorated `agent_start` calls.

Options under consideration:
- Remove `defaultPolicy` from profiles entirely; hardcode `sandbox.defaultPolicy()` as the universal base.
- Keep `defaultPolicy` but make it optional; fall back to `sandbox.defaultPolicy()` when absent.
- Split profile into two concepts: *endpoint* (URL, key, temperature) and *capability set* (what the endpoint is trusted to do). Agent defs reference an endpoint; their tool lists are the effective policy with no ceiling from the profile.

### User-wide agent library

A fallback lookup at `~/.claude/agnz/agents/` before `<cwd>/.claude/agnz/agents/`. Lets you maintain a set of reusable roles (a generic `researcher`, a `summariser`) without copying files per project. Per-project definitions shadow user-wide ones by name.

### Role-based message routing

`to: "role:researcher"` fans out to all active threads running the `researcher` agent def. Deferred until multi-instance roles actually appear in practice.
