# ADR 0005: Skills for agents — composable instruction sets via tool call

- **Status:** Superseded by [ADR 0006](./0006-agentic-system-skills-memory-initialprompt.md)
- **Date:** 2026-04-09
- **Depends on:** [ADR 0003](./0003-agent-definitions.md)

## Context

ADR 0003 gives an agent a role via a system prompt in its `.md` body. That body is static — written once when the agent definition is created and injected in full at thread start, whether or not all of it is relevant for a given task.

Claude Code already has a concept of *skills*: plain markdown files (with YAML frontmatter) that describe a focused capability — how to do TDD, how to write a frontend component, how to triage a Jira issue. When Claude needs one, it loads the skill on demand via the `Skill` tool and the content lands in context right when it is needed.

Sub-agents today have no equivalent. An agent that needs to know "how to write structured commit messages" or "the project's test patterns" has to have that knowledge baked into its system prompt from the start. That conflates role definition with task-specific guidance: the system prompt grows, the agent carries knowledge it may never use, and reusing patterns across agents means copy-paste.

We want sub-agents to be able to call skills the same way Claude Code does — on demand, by name — and we want to start with skills that live in the project itself, not try to wire into the full installed-plugin registry from day one.

## Decision

### 1. A new tool: `use_skill`

Sub-agents get a `use_skill` tool with two actions:

```
use_skill({ action: "list" })
  → "Available skills:\n- commit-style: ...\n- test-patterns: ..."

use_skill({ action: "load", name: "commit-style" })
  → <full body of the skill's SKILL.md>
```

The agent calls `list` to discover what is available, then `load` to pull in the content of whichever skill is relevant for the current task. The loaded content lands in the conversation as a tool result — the LLM reads it and follows the instructions, exactly like CC's `Skill` tool.

**Default policy: `allow`.** The tool is read-only. It never modifies files and reads only from pre-defined discovery paths, not from caller-supplied paths. No path-traversal risk, no sandbox violation.

### 2. Skill discovery — V1 scope: project-local only

Skills are discovered from a single location in V1:

```
<cwd>/.claude/skills/<skill-name>/SKILL.md
```

This is the project's own skill library, co-located with other Claude Code state under `.claude/`. Users write these files by hand (or with Claude's help) the same way they write agent definitions. Skills are plain markdown with YAML frontmatter:

```markdown
---
name: commit-style
description: How to write commit messages in this project.
---

Always use conventional commits (feat/fix/chore/docs/refactor).
Subject line ≤ 72 characters. No trailing period.
...
```

**Why project-local only in V1?** Installed plugins expose skills too
(`~/.claude/plugins/cache/.../skills/*/SKILL.md`), but the plugin cache contains
*all downloaded versions* of *all plugins*, including disabled ones and stale
versions. Indiscriminately exposing everything in the cache would surface skills
that are not active in the user's session. Determining which plugins are currently
enabled requires reading CC's own settings, which is a fragile coupling we want to
avoid in V1. Project-local skills are unambiguously "intended to be here" — no
guessing required.

Plugin skills are deferred to a later ADR (see Deferred section).

### 3. SKILL.md format

The same format Claude Code uses for plugin skills. A `SKILL.md` file has:

- **Frontmatter** (between `---` fences): `name` and `description` are the only required fields for `use_skill`'s `list` output. Additional frontmatter fields (trigger phrases, etc.) are ignored by `use_skill` — they are meaningful to CC but not to the sub-agent.
- **Body**: the content returned by `action=load`. Frontmatter is stripped; only the body is returned. The sub-agent reads it as plain prose and applies the instructions.

Using the same format means any skill already written for Claude Code can be dropped into `.claude/skills/` and immediately used by sub-agents too, without modification.

### 4. Agent definition: optional `skills` allowlist

An agent definition may declare which skills it is allowed to use:

```markdown
---
name: editor
profile: lmstudio-devstral
description: Writes and revises code following project conventions.
skills:
  - commit-style
  - test-patterns
  - api-naming
---
```

The `skills` field is a YAML sequence (indented list items with `- `). If present, `use_skill` only exposes the named skills to that agent. If absent, all project-local skills are available. An empty list (`skills: []` — not yet supported by the parser; treated as "no restriction" for now) is reserved.

**Why an allowlist?** Agents should be purposeful. A researcher agent probably does not need the `commit-style` skill; offering it only adds noise to `use_skill({ action: "list" })`. The allowlist also makes the agent definition self-documenting: a reader can see at a glance what capabilities the agent draws on.

### 5. Parser extension in `agent-defs.mjs`

The existing frontmatter parser in `agent-defs.mjs` already handles nested maps (`tools:`). The `skills:` field is a **sequence** — a different structure:

```yaml
skills:
  - commit-style
  - test-patterns
```

The parser gets a new branch: when it sees `skills:` with an empty value (like `tools:`), it reads subsequent lines that match `/^\s+-\s+(\S+)/` as list items until it hits a zero-indent non-list line or the closing `---`. The result is `def.skills: string[]`. Unknown skill names are not validated at parse time — the tool silently omits missing skills from the list result rather than failing at thread-start.

### 6. Tool construction and wiring

`use_skill` is not a static singleton like the other tools. It needs to know:

- `cwd` — to find `<cwd>/.claude/skills/`
- `allowList` — from the agent def's `skills` field (or `null` for all)

It is constructed in the same place the other tools are: `mcp/server.mjs` at `agent_start` time, once the agent def is resolved. The registry receives it alongside the built-in tools.

Catalog discovery is **lazy and cached per thread**: the first call to `use_skill` reads the `skills/` directory, subsequent calls within the same thread reuse the result. Re-discovering on every call would add latency for a directory that does not change mid-run.

### 7. What the agent does with a loaded skill

The agent decides when to call `use_skill`. It does not call it automatically on every task. The system prompt for agents with a `skills` list should include a brief pointer:

> "You have skills available via `use_skill`. List them with `action=list` and load relevant ones before starting a task."

This line is injected automatically by `loop.mjs` when `thread.agentDef.skills` is non-empty (or when any project-local skills exist). Without the hint the agent may not think to use the tool.

### 8. What we are NOT building in this ADR

- **Plugin skills.** Deferred. See below.
- **Skill arguments.** CC skills can receive arguments (e.g. a PR number). Sub-agent skills are argument-free in V1 — the content is static. If parameterised skills are needed later, the agent can interpolate its context into the instructions after loading.
- **Skill composition / includes.** One skill cannot reference another. If two skills share common content, copy it. We have seen that abstraction too early creates maintenance burden without payoff.
- **Sub-agent-authored skills.** An agent cannot write new skills to disk during a run. Skills are authored by humans (or Claude, interactively). A sub-agent is a consumer, not a producer.

## Consequences

### Positive

- **Agents stay lean.** Role bodies stay focused on *who the agent is*; task-specific *how-to* knowledge lives in skills and is loaded on demand.
- **Reuse without copy-paste.** A `commit-style` skill written once is available to every agent that lists it. Updating the skill file updates all agents that use it.
- **Zero new file formats.** SKILL.md is what CC already uses. Users who know CC feel at home.
- **Incrementally adoptable.** Agents without a `skills` field work exactly as before. Adopting skills is a one-line addition to the agent def.

### Negative

- **Discovery latency on first call.** `readdir` on the skills directory adds a small delay on the first `use_skill` call per thread. For a local filesystem this is negligible but worth noting.
- **Agent must know to use the tool.** Without the system-prompt hint (§7), the agent may not call `use_skill` at all. The hint adds a few tokens to every system prompt for agents with skills configured.
- **Skill content is unsandboxed.** A skill file can contain arbitrary instructions, including ones that contradict the agent's role. Since skills are authored by the project owner (same person who writes agent definitions), this is accepted. We do not validate skill content.

### Neutral

- **Empty skills directory = tool still present.** If `<cwd>/.claude/skills/` is missing or empty, `use_skill({ action: "list" })` returns "No skills available." The tool is still registered. This is consistent with other tools that have no-op states (e.g. `send_message` when no recipients are listening).

## Deferred

### Plugin skills

Once we decide how to determine which plugins are *active* (as opposed to merely downloaded), we can extend `discoverSkillFiles()` to also scan the relevant subset of `~/.claude/plugins/cache/`. The interface (`use_skill` with `list`/`load`) does not change — discovery is an implementation detail. The open question is the source of truth for "active plugins":

- Read from CC settings JSON (fragile, format may change)
- Maintain an explicit enabled-plugins list in `workspace.json` (user has to opt in)
- Simply scan all installed plugins and accept that disabled plugins' skills appear in the list (simplest, but noisy)

This decision belongs in a follow-up ADR or a minor amendment here.

## File layout after this ADR

```
<cwd>/.claude/
├── agnz/
│   ├── workspace.json
│   ├── messages.jsonl
│   ├── cursors/
│   ├── agents/
│   │   └── editor.md        ← skills: [commit-style, test-patterns]
│   └── threads/
└── skills/                  ← NEW: project-local skill library
    ├── commit-style/
    │   └── SKILL.md
    └── test-patterns/
        └── SKILL.md
```
