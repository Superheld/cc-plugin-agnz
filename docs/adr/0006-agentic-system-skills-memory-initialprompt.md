# ADR 0006: Agentic system — skills injection, memory, initialPrompt

- **Status:** Proposed
- **Date:** 2026-04-09
- **Supersedes:** [ADR 0005](./0005-skills-for-agents.md) (skill delivery mechanism)
- **Depends on:** [ADR 0003](./0003-agent-definitions.md)

## Context

After studying Claude Code's sub-agent documentation in depth, three gaps in our current design became clear:

**Skills (ADR 0005 correction).** ADR 0005 implemented skills as an agent tool (`use_skill`, now renamed `Skill`) that the sub-agent calls at runtime to discover and load skill content on demand. This conflicts with how CC handles skills: skills are a *framework-level system*, not a tool. When `skills:` is set in an agent definition, CC injects the full SKILL.md content into the agent's context at startup — before the first turn. There is no `Skill` tool in CC. Our tool-based approach was an independent design decision, not a CC-compatible one. This ADR corrects that.

**Memory.** CC supports a `memory:` frontmatter field that gives a sub-agent a persistent directory (`MEMORY.md` and friends) that survives across conversations. The first 200 lines of `MEMORY.md` are injected into the system prompt at startup. agnz had a memory module in 0.3.x that was deleted in 0.4.0 because it was per-project global state (not per-agent). CC's design — per-agent, scoped to a named directory — avoids that problem.

**initialPrompt.** CC supports an `initialPrompt:` frontmatter field that is auto-submitted as the first user turn when an agent runs as a main-thread agent. Useful for bootstrapping agents with initial context or instructions that should not be part of the system prompt but should appear as the first input.

## Decisions

### 1. Skills — catalog in system prompt, body on demand

Remove the `Skill` tool from the tool registry and the default policy. Skills use the same progressive-disclosure model as the main Claude Code session: the agent sees a catalog of available skills (name + description + path) in its system prompt at startup, and reads the full SKILL.md body with the `Read` tool when it decides it needs one.

**When `skills:` is set** in the agent definition:
1. At thread start, read the frontmatter of each named skill's SKILL.md at `<cwd>/.claude/skills/<name>/SKILL.md`.
2. Inject a catalog block into the system prompt between the sandbox-framing section and the agent def body:

```
Available skills (Read the full SKILL.md path when you need one):
- commit-style: Conventional commit message guidelines — /abs/path/to/.claude/skills/commit-style/SKILL.md
- test-patterns: Project test patterns and helpers — /abs/path/to/.claude/skills/test-patterns/SKILL.md
```

3. Unknown skill names are skipped silently.

**When `skills:` is not set**: no catalog is injected. The sub-agent has no skill awareness. (Compatible with CC: subagents don't inherit skills from the parent conversation.)

**Full skill body loading**: the agent calls `Read` on the absolute path in the catalog when it needs the full content. No dedicated tool needed — `Read` is already available and the path is provided.

**Why catalog, not full injection**: local models have limited context windows. Injecting the catalog keeps the startup context small; the agent loads only what it needs. This mirrors how CC itself works: descriptions always in context, full body on demand. The agent decides what it needs.

### 2. Memory — per-agent persistent directory

Add a `memory:` frontmatter field. Three scopes (matching CC):

| Scope | Path | Use when |
|---|---|---|
| `user` | `~/.claude/agnz/agent-memory/<name>/` | knowledge applies across all projects |
| `project` | `<cwd>/.claude/agent-memory/<name>/` | project-specific, version-controllable |
| `local` | `<cwd>/.claude/agent-memory-local/<name>/` | project-specific, not committed |

When `memory:` is set:
1. Create the directory if it does not exist.
2. Read `MEMORY.md` from that directory (up to 200 lines / 25 KB, whichever comes first).
3. Inject it into the system prompt after the sandbox-framing section, before skills and agent def body.
4. Append instructions to the system prompt: "You have a persistent memory directory at `<path>`. Read `MEMORY.md` at the start of each task to recall prior context. Update it after each task with new findings. Keep entries concise."
5. `Read`, `Write`, and `Edit` are automatically enabled for the memory path even if the agent def's tool policy would otherwise deny them. (The memory directory is outside the sandbox root, so it needs an explicit carve-out in path resolution.)

**MEMORY.md format:** free-form markdown. The agent manages it. Entries are timestamped by convention but not enforced by the framework.

**Why not global memory:** global memory (`memory.mjs` in 0.3.x) conflated per-project state for all agents. Per-agent scoped directories avoid that. Each named agent role accumulates its own knowledge base.

### 3. initialPrompt — auto-submitted first turn

Add an `initialPrompt:` frontmatter field (string). When set:
1. At thread start (new user message), prepend `initialPrompt` to the first user message if the thread has no history.
2. If `agent_start` is called with an explicit user message *and* `initialPrompt` is set, the combined message is `<initialPrompt>\n\n<user message>`.
3. If the thread already has history (resumed thread), `initialPrompt` is not re-injected.

Use cases:
- Bootstrapping an agent with project context it should always have ("The project is a TypeScript monorepo. Always check tsconfig.json before editing types.")
- Giving an agent a standing first instruction without polluting its system prompt (which is role definition, not task context).

**Differences from CC:** CC's `initialPrompt` is primarily for agents running as main-thread agents (`claude --agent`). agnz agents always run as sub-agents, so `initialPrompt` makes sense for any thread. Skills and commands in `initialPrompt` are not processed (agnz has no equivalent of CC's skill-invocation syntax in prompts).

## Implementation order

1. **Skill injection** (removes `Skill` tool, adds injection at `buildMessages` time). Unblocks correct agent file format.
2. **Memory** (new directory, MEMORY.md injection, system-prompt instructions, sandbox carve-out).
3. **initialPrompt** (simpler: prepend at thread-start in `loop.mjs`).

## Files affected

| File | Change |
|---|---|
| `lib/tools/Skill.mjs` | Remove from registry (file stays for reference, not imported) |
| `lib/tools/registry.mjs` | Remove `Skill` import and from `BUILTIN` |
| `lib/sandbox.mjs` | Remove `Skill` from `defaultPolicy` |
| `lib/agent-defs.mjs` | Remove auto-Skill-restore from `mergeEffectivePolicy` |
| `lib/loop.mjs` | Add skill injection in `buildMessages`; add memory preamble; add `initialPrompt` prepend |
| `lib/data-dir.mjs` | Add `resolveAgentMemoryDir(scope, agentName)` |
| `lib/agent-defs.mjs` | Parse `memory` and `initialPrompt` frontmatter fields |
| `mcp/server.mjs` | Update tool description (remove Skill mention) |
| `skills/agents/references/defining.md` | Document `memory` and `initialPrompt` fields |
| `CLAUDE.md` | Update module map |

## Compatibility notes

- Existing agent def files with `skills:` will automatically get injection behaviour once implemented — no migration needed.
- The `Skill` tool is removed; any agent def that previously listed `Skill` in its `tools:` whitelist will now have an unrecognised tool name silently ignored by `mergeEffectivePolicy` (unknown tools not in the profile policy pass through).
- CC agent files that use `skills:` are now fully compatible with agnz's injection behaviour.
