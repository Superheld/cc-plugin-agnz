# ADR 0003: Agent definitions — roles on top of profiles

- **Status:** Active (living document)
- **Date:** 2026-04-08
- **Updated:** 2026-04-11
- **Branch:** `feat/cc-agent-compatibility`
- **Depends on:** [ADR 0001](./0001-workspace-first-architecture.md), [ADR 0002](./0002-communication-mailbox-and-events.md)

## Context

Today, an agnz "sub-agent" is parameterised entirely by a *profile*: `{baseUrl, apiKey, model, temperature, defaultPolicy, ...}`. A profile describes an **endpoint** — where the LLM lives and what its raw behaviour is. It does not describe what the agent *is for*: its role, its specialisation, its system prompt, whether it is allowed to write files, how it should communicate.

That conflation was fine when agnz had one sub-agent at a time. Once we have a workspace that is a team — a researcher alongside an editor alongside a tester, each potentially using a different local model — we need a layer above profiles. A researcher on Devstral and an editor on Devstral both use the same endpoint but should behave very differently. The same researcher, tomorrow, might move to Qwen without any change to its role, prompt, or tool policy.

We also want the team to feel like Claude Code's native agent system without *being* that system. Claude Code's subagent mechanism (`general-purpose`, `Explore`, user-defined agents under `.claude/agents/*.md`) is Anthropic-model-only; it cannot route to a local endpoint. agnz is the parallel system that does exactly that. It should borrow the ergonomics: markdown files with YAML frontmatter, one agent per file, a natural directory to drop them in.

## Decision

agnz loads agent definitions from **Claude Code's standard agent locations**. No separate agnz-specific agent directory exists. This means agents defined for CC are immediately available to agnz without duplication.

### 1. Location (CC standard)

```
~/.claude/agents/              ← user-wide (global agents)
<cwd>/.claude/agents/          ← project agents
```

agnz follows the same lookup order as CC:
1. Project agents (`<cwd>/.claude/agents/`) shadow user agents with the same name.
2. User agents (`~/.claude/agents/`) are the fallback.

No `agents/` subdirectory under `.claude/agnz/` exists. All agent loading goes through the CC paths.

### 2. File format: Markdown with YAML frontmatter

Agent files use **CC native format**: the description is a plain scalar that
may span multiple lines including `<example>` blocks; array fields use inline
JSON arrays. YAML block scalars (`|`, `>`) and block sequences (`- item`) are
also accepted for backwards compatibility, but CC native is preferred for new
files.

```markdown
---
name: researcher
description: Use this agent when the user asks to investigate code, find where
something is used, trace a data flow, or summarise a module.

<example>
Context: User wants to find all usages of a function.
user: "Where is parseAgentDefSource called?"
assistant: "Let me have the researcher grep for all call sites."
<commentary>
Grep sweep across the tree, no edits.
</commentary>
</example>

model: lmstudio
color: blue
disallowedTools: ["Edit", "Write", "Bash"]
maxTurns: 40
---

You are a research sub-agent. Your role is to investigate code: read files,
search for patterns, and produce concise, factual summaries. You do not modify
files.
```

**Array fields: CC native (preferred) vs YAML block (accepted)**

```yaml
# CC native — single line, JSON array:
disallowedTools: ["Edit", "Write", "Bash"]

# YAML block — also accepted:
disallowedTools:
  - Edit
  - Write
  - Bash
```

**Text fields: CC native (preferred) vs YAML block scalar (accepted)**

```yaml
# CC native — first line on same key, <example> blocks below, no indicator:
description: Read-heavy investigation. Does not modify files.

<example>
...
</example>

# YAML block scalar — also accepted:
description: |
  Read-heavy investigation. Does not modify files.
```

**Frontmatter fields:**

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Unique within the workspace. Lowercase, `[a-z][a-z0-9-]*`. |
| `profile` | yes | Name of an existing profile in the user-wide profile store. |
| `description` | yes | Routing description. The **first line** must be self-contained — it is the compact form injected by hooks and displayed in summaries. Subsequent lines may contain `<example>` blocks. Used by the parent to pick which agent to spawn. |
| `tools` | no | Explicit allowlist of tool names. Format: `["Read", "Grep"]` (CC native) or YAML block sequence. PascalCase names matching CC built-ins: `Read`, `Grep`, `LS`, `Edit`, `Write`, `Bash`, `AskUser`, `SendMessage`, `Skill`. If set, only listed tools are available. |
| `disallowedTools` | no | Explicit denylist. Format: `["Edit", "Write"]` (CC native) or YAML block sequence. Applied on top of the profile's defaultPolicy. |
| `skills` | no | Skill names the agent may load on demand via the `Skill` tool from `<cwd>/.claude/skills/<name>/SKILL.md`. Format: `["workspace", "agents"]` (CC native) or YAML block sequence. |
| `temperature` | no | Override the profile's temperature for this role. |
| `maxTurns` | no | Override the profile's `maxTurns`. |
| `prompt` | no | Inline system prompt (alternative to markdown body). CC-compatible. |
| `initialPrompt` | no | Initial prompt injected at session start. CC-compatible. |

Tool names are **PascalCase** matching Claude Code's built-in tool naming, so agent definition files can be shared between CC and agnz without modification.

**System prompt resolution:** If `prompt:` is set in frontmatter, it is used as the agent's system prompt. Otherwise, the markdown body below the frontmatter is used. Both are concatenated with the default agnz system prompt (sandbox rules, tool discipline, mailbox instructions) to form the sub-agent's final system message.

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
2. The server resolves the agent file from CC standard locations (project first, then user):
   - `<cwd>/.claude/agents/researcher.md` (project scope)
   - `~/.claude/agents/researcher.md` (user scope)
3. Parses frontmatter + body. Validates schema (name present, profile resolvable, tools keys known).
4. Looks up the referenced profile in the user-wide profile store.
5. Resolves the model via workspace model mappings (see §4a).
6. Merges: profile's `defaultPolicy` is the base; agent's `tools`/`disallowedTools` override per key. Other fields (temperature, maxTurns) override the profile's values when present.
7. System prompt for the sub-agent: `[sandbox-framing] + [tool restrictions] + [skills catalog if skills: is set] + [agent prompt:]`.
8. Thread meta stores a **snapshot** of the resolved agent definition, not just the file path — the thread continues with the definition it was spawned under regardless of later edits to the file.

### 4a. Model-to-profile mapping

CC agent definitions may specify a `model:` field with CC identifiers (`opus`, `sonnet`, `haiku`) or arbitrary strings. These are mapped to **profile names** via `workspace.json`. The profile carries the actual endpoint configuration and the current model string (whatever the endpoint is serving).

```json
{
  "modelProfileMappings": {
    "opus": "lmstudio-large",      // agent with model: opus → profile lmstudio-large
    "sonnet": "lmstudio-devstral", // agent with model: sonnet → profile lmstudio-devstral
    "_default": "lmstudio-default"  // fallback profile
  }
}
```

**Resolution order:**
1. `modelProfileMappings[agentModel]` — explicit mapping to profile name
2. `modelProfileMappings["_default"]` — fallback profile name
3. original model string — treat as profile name (forward compatible)

**Why map to profiles, not directly to models?**
- When LM Studio loads a different model, only the profile needs updating — all agents that use that profile automatically get the new model.
- No need to update mappings across all workspaces when models change.
- The profile carries endpoint details (baseUrl, apiKey) that the agent shouldn't need to know about.

The resolved profile provides `baseUrl`, `apiKey`, and `model` for the LLM API call. If `modelProfileMappings` is absent or a key is unmapped, the model identifier is used directly as the profile name.

### 5. Tool policy: profile is the upper bound

An agent definition's tool lists may **restrict** but not **expand** what the profile allows:

- If the profile says `Edit: ask` and the agent has `Edit` in `disallowedTools`, the agent cannot edit files. Deny wins.
- If the profile says `Edit: deny` and the agent has `Edit` in `tools`, the agent **cannot** edit files. The deny stands.
- The effective policy for tool T is `strictest(profile[T], agent[T])`, where `deny > ask > allow`.

This is deliberate. The profile is the user's trust setting for the endpoint (what can this model's process touch at all?), and an agent role is only ever a further narrowing of that.

#### 5a. Known confusion: three overlapping layers

In the current implementation, tool access is determined by three mechanisms that interact without a single clear precedence rule:

1. `sandbox.defaultPolicy()` — hardcoded baseline (Read/Grep/LS → allow, Edit/Write/Bash → ask)
2. Profile `defaultPolicy` — can override sandbox defaults per tool
3. Agent def `tools:` (allowlist) + `disallowedTools:` (denylist) — role-level overrides

The `tools:` / `disallowedTools:` duality is particularly confusing: `tools:` means "expose only these in the schema", `disallowedTools:` means "deny these regardless". A tool that appears in neither list falls through to the profile defaultPolicy. Mixing both lists in one agent def produces ambiguous results.

**Until ADR 0009 presets are implemented:** use `disallowedTools:` to deny specific tools, or use `tools:` for strict allowlist semantics — but not both. ADR 0009 (presets + tool_config) supersedes this with a cleaner model where a preset selects the base tool set and a single `tools:` map overrides per-tool policy.

#### 5b. Bash: sandbox bypass

`Bash` is the only tool that does **not** honour the sandbox path restriction.

The sandbox's `resolvePath()` restricts `LS`, `Read`, `Grep`, `Edit`, and `Write` to the cwd root — if a path escapes the root, the tool call is rejected. `Bash` does not go through `resolvePath`. It sets the shell working directory to cwd, but a command like `cat /etc/passwd` or `cat ~/.claude/profiles.json` succeeds regardless of the sandbox root.

Practical consequences:

- **An agent with `Bash: ask` has effective full-filesystem read/write access**, mediated only by Parent Claude approving each call. That is human-gating, not technical sandboxing.
- **An agent that should be read-only must have `Bash: deny`** — not just `ask`. This is the only way to technically prevent shell-based file access outside the sandbox.
- The `read-only` preset (ADR 0009) enforces this automatically: `Bash` is not registered in the tool schema at all.
- Any agent that genuinely needs shell execution should use `tool_config.bash.allowedCommands` (ADR 0009) to restrict which commands are permitted, reducing the blast radius.

**The researcher and similar read-only roles must carry `Bash` in `disallowedTools:` (or use the `read-only` preset) — treating `Bash: ask` as "safe enough" is incorrect.**

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

#### Description field: what makes a good one

The description answers three questions Claude needs for routing:
- What kind of work does this agent do?
- What are concrete examples of tasks to delegate to it?
- What does it explicitly NOT do?

**Good (specific, negative case included):**
```yaml
description: >
  Read-heavy code investigation: bulk file reads, grep sweeps,
  "find everywhere X is used", module summaries. Does not modify files.
  Good for: understanding unfamiliar code, finding all call sites,
  summarising a large module before planning changes.
```

**Bad (too vague for routing):**
```yaml
description: A researcher agent that reads code.
```

Claude receives agent descriptions via two channels:
1. **Direct file read** — `Read`/`Glob` on `<cwd>/.claude/agnz/agents/*.md` when it wants the full frontmatter.
2. **Hook injection** — the `SessionStart` hook (ADR 0007) injects a compact workspace summary at session start that includes agent names and their one-line descriptions, so Claude has baseline routing knowledge without needing to read files first.

The compact format injected by the hook is `<name> — <first line of description>`. This means the first sentence of `description:` must be self-contained and actionable — the rest of the block is detail for when Claude reads the full file.

### 8. What we are not building in this ADR

- **No built-in agent library.** The plugin ships with zero agents.
- **No inheritance between agents.** Copy and modify if you need variants.
- **No runtime reload.** Editing an agent file mid-thread does not affect the running thread.
- **No team composition files.** A team is all agents you have spawned in the workspace.
- **No separate agnz agent directory.** Agents live in CC's standard locations only. This avoids duplication and keeps agnz compatible with CC's agent ecosystem.

## Consequences

### Positive

- **Clean separation of "where" and "what."** Swapping endpoints does not disturb roles.
- **Agent files are reviewable and versionable.** Plain text, diff cleanly.
- **Full CC compatibility.** Agents defined for CC work in agnz without modification.
- **User-wide agents shared across projects.** A great `researcher` agent at `~/.claude/agents/` is available in every project.
- **Project agents shadow user agents.** Teams can define project-specific agents that override shared ones.
- **Parent routing is data-driven, not hard-coded.** Add a new agent file and Claude can use it immediately.
- **Profiles stay simple.** Pure endpoint description.

### Negative

- **Description quality matters.** A sloppy `description` leads to Claude picking the wrong agent.
- **The tool policy asymmetry can confuse users.** "I added `Edit` to `tools:` but it still can't edit files" — because the profile denies it. Documentation must call this out clearly.
- **Snapshot-on-spawn means stale agents keep running.** Fixing a bug in a running agent's prompt only takes effect for newly-spawned threads.

## Interaction with ADR 0001 and 0002

ADR 0001 established the workspace directory. This ADR defines the agent lookup paths (CC standard, not under `.claude/agnz/`):

```
<cwd>/.claude/
├── agents/                        ← CC standard location (project)
│   └── <name>.md
├── agnz/
│   ├── workspace.json              ← contains modelMappings (this ADR §4a)
│   ├── messages.jsonl            (0002)
│   └── threads/
│       └── <id>.meta.json         ← extended: `agentDef` snapshot, `model`
└── skills/                       ← CC standard skills location (0005)
    └── <name>/
        └── SKILL.md
```

User-wide agents live at `~/.claude/agents/`.

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

**Implemented via CC standard paths.** User agents live at `~/.claude/agents/`, project agents at `<cwd>/.claude/agents/`. Project agents shadow user agents with the same name. No separate agnz directory exists.

### Role-based message routing

`to: "role:researcher"` fans out to all active threads running the `researcher` agent def. Deferred until multi-instance roles actually appear in practice.
