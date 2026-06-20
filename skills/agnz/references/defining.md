# Defining an agent role

Companion to [SKILL.md](SKILL.md). This covers the full `.md` + frontmatter format, the policy-merge rules, and a few example roles you can copy.

## Where agent files live

agnz resolves agent names in three layers (project shadows user shadows plugin):

```
<cwd>/.claude/agents/      ← project-local (highest priority)
~/.claude/agents/          ← user-wide
<plugin>/agents/           ← plugin-bundled: dev, researcher, reviewer, general
```

Plugin-bundled agents are available in every project without any setup. Create a file in `<cwd>/.claude/agents/` with the same name to override a plugin agent for a specific project.

## File format

Markdown with YAML frontmatter. The frontmatter holds structured fields; the body (everything after the closing `---`) is the agent's system prompt, which gets concatenated onto the default sandbox-framing prompt.

agnz agent files follow the same format as Claude Code's built-in agent definitions, so files can be copied and adapted between the two systems. The `tools` and `disallowedTools` fields are compatible — both CC and agnz use string arrays.

```markdown
---
name: researcher
description: |
  Use this agent when the user asks to investigate code, find where something
  is used, or summarise a module. Examples:

  <example>
  Context: User wants to understand the codebase structure.
  user: "How does request logging work in this project?"
  assistant: "I'll delegate this to the researcher agent."
  <commentary>
  Read-heavy investigation with no file edits needed.
  </commentary>
  </example>
model: lmstudio-devstral
color: blue
disallowedTools:
  - Edit
  - Write
  - Bash
temperature: 0.2
maxTurns: 40
---

You are a research sub-agent. Investigate code, search for patterns,
and produce concise, factual summaries. You do not modify files.

When finished, reply with a one-paragraph summary of what you found
and, if relevant, a bullet list of file:line references.
```

## Frontmatter fields

| Field | Required | Type | Meaning |
|---|---|---|---|
| `name` | yes | `[a-z][a-z0-9_-]*` | Unique within the workspace. Used in mailbox addressing and appears in logs. |
| `description` | yes | string | How Parent Claude routes tasks to this role. Use `\|` for multi-line with `<example>` blocks (see below). **Be specific.** |
| `model` | no | string | agnz profile name (e.g. `lmstudio-devstral`). Falls back to the active profile if absent. |
| `color` | no | string | CC-compatible visual identifier (`blue`/`cyan`/`green`/`yellow`/`magenta`/`red`). Stored for future use. |
| `tools` | no | string array — **whitelist** | Listed tools are permanently `allow`; tools NOT listed default to `ask` (not `deny`). If absent, all tools are available with their sandbox-default policy. Profile is the upper bound — listing a tool can never promote it beyond what the profile allows. |
| `disallowedTools` | no | string array — **blacklist** | Listed tools are denied regardless of the whitelist or profile. |
| `skills` | no | string array | Allowlist of project-local skills the agent may load via the `Skill` tool. If absent, all skills are available. |
| `temperature` | no | number | Overrides the profile's `temperature` for this role. |
| `maxTurns` | no | positive integer | Overrides the profile's `maxTurns`. |

### Description format

Three supported forms, all parsed correctly by agnz:

**Plain prose** (most common):
```yaml
description: Read-heavy code investigation. Bulk reads, grep sweeps, summaries of large modules.
```

**Folded block** (`>`) — for longer prose without preserved newlines:
```yaml
description: >
  Read-heavy code investigation. Bulk reads, grep sweeps,
  summaries of large modules.
```

**Multi-line with `<example>` blocks** — CC native format, plain indented continuation lines:
```yaml
description: Use this agent when the user asks to investigate code. Examples:

  <example>
  Context: User wants to understand the codebase structure.
  user: "How does request logging work?"
  assistant: "I'll delegate this to the researcher agent."
  <commentary>Read-heavy, no edits needed.</commentary>
  </example>
```

The parser detects where the description ends by looking for the next known frontmatter key (`model:`, `tools:`, etc.) at column 0. `<example>` content is excluded from this detection so `user:` and `model:` inside examples don't accidentally terminate the description.

### The markdown body = system prompt

Everything after the closing `---` is the body. It is **concatenated** onto `agnz`'s default sandbox-framing prompt (not a replacement). So you don't need to re-explain things like "you are in a sandbox, your cwd is X, do not narrate" — that's already there. Use the body for what makes *this* role specific: voice, priorities, handoff rules, what "done" looks like.

Keep it in prose with concrete instructions. Avoid vague "you are helpful" language — local models are more literal than frontier models and reward precise instructions.

## The tool policy model — profile is the upper bound

The available tools in agnz (PascalCase, matching CC naming):

| Tool | Sandbox default | Description |
|---|---|---|
| `LS` | allow | List directory contents |
| `Read` | allow | Read file contents |
| `Grep` | allow | Search file contents with regex |
| `AskUser` | allow | Pause and ask the parent a question |
| `SendMessage` | allow | Send a message to another agent or parent |
| `Skill` | allow | Discover and load project-local skills |
| `Edit` | ask | Edit a file (pauses for approval) |
| `Write` | ask | Write a file (pauses for approval) |
| `Bash` | ask | Run a shell command (pauses for approval) |

Note: there is no `defaultPolicy()` function. The "Sandbox default" column shows the effective policy when no `tools:`/`disallowedTools:` is set in the agent def. The sandbox defaults to `ask` for any tool not explicitly listed.

For every tool, the effective policy is `strictest(profile[T], agent[T])`, with strictness ordering `deny > ask > allow`.

- **`tools` (whitelist): Listed tools become `allow`; unlisted tools fall back to `ask`.** Listing `Edit` in `tools` makes it permanently allowed — it cannot be promoted beyond what the profile permits. If the profile says `Edit: ask`, listing it in `tools` allows it; if the profile says `Edit: deny`, listing it in `tools` cannot unlock it.
- **`disallowedTools` (blacklist): Always denied.** Overrides both whitelist and profile.
- **Profile `deny` wins absolutely.** If the profile says `Bash: deny`, no agent definition can unlock it. Upgrade the profile first.

### Note on `Skill` + `tools` whitelist

If you use a `tools:` whitelist **and** a `skills:` list, add `Skill` to the whitelist or the sub-agent will see the skills hint in its system prompt but won't be able to call the tool. agnz auto-adds `Skill` to the effective policy when `skills:` is set, so omitting it from `tools:` is caught automatically — but being explicit is clearer.

## Example roles

### researcher — read-only

```markdown
---
name: researcher
description: >
  Read-heavy code investigation. Bulk reads, grep sweeps,
  "find everywhere X is used", summaries of large modules.
model: lmstudio-devstral
color: blue
disallowedTools:
  - Edit
  - Write
  - Bash
---

You investigate code and produce concise, factual summaries.
You do not modify files, full stop. If asked to edit, refuse
and explain that you are a read-only agent.

When you finish an investigation, reply with a one-paragraph
summary of what you found and, if relevant, a bullet list of
file:line references.
```

### editor — mechanical changes with approval

```markdown
---
name: editor
description: >
  Mechanical edits across many files — renames, format changes,
  adding a field to a type in every import site. Not for design
  work or refactoring that requires judgement.
model: lmstudio-devstral
color: green
temperature: 0.1
---

You perform precise, mechanical edits. Before editing a file,
read it so your old_string matches exactly. Make ONE change per
turn; do not batch edits. After each change, confirm what you
changed in one sentence. Ask the user (AskUser) if the
instructions are ambiguous — do not guess.
```

Note the `temperature: 0.1` — editors are the one role where low entropy is worth the extra stubbornness.

### tester — runs known commands

```markdown
---
name: tester
description: >
  Runs project tests and reports results. Knows this project's
  test commands and how to interpret their output.
model: lmstudio-devstral
color: yellow
tools:
  - Read
  - Bash
---

You run `npm test` (or the project's equivalent — check
package.json first) and report back. On failure, identify the
failing test file and line if possible, and quote the exact
error message. Do not attempt to fix failures — that's not
your job; just report.
```

Note: `Bash` has policy `ask` by default so the first run will pause for approval. Approve with `persist: true` to unblock for the rest of the thread.

## Snapshot-on-spawn — what that means for you

When you run `agnz start <name> --agent researcher`, agnz reads the file *once*, parses it, resolves its profile, merges the effective policy, and stores the result as a **snapshot** on the thread meta. From that moment the thread is running against the snapshot — editing the file afterwards does not affect the running thread.

Implications:

- **Safe to iterate on role files without hurting in-flight threads.**
- **Confusing if you expected live reload.** If you edit `researcher.md` and wonder why the sub-agent still behaves the old way — start a fresh thread to pick up the new version.
- **The snapshot is readable.** Look at `<cwd>/.claude/agnz/threads/<id>.meta.json`'s `agentDef` field to see exactly which version of the role the thread is running against.
