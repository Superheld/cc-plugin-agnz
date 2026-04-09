# Defining an agent role

Companion to [SKILL.md](SKILL.md). This covers the full `.md` + frontmatter format, the policy-merge rules, and a few example roles you can copy.

## Where agent files live

```
<cwd>/.claude/agnz/agents/
├── researcher.md
├── editor.md
└── tester.md
```

Per-project only — no user-wide fallback. If you want a library of reusable roles, keep them in a template repo and copy them in.

## File format

Markdown with YAML frontmatter. The frontmatter holds structured fields; the body (everything after the closing `---`) is the agent's system prompt, which gets concatenated onto the default sandbox-framing prompt.

agnz agent files follow the same format as Claude Code's built-in agent definitions, so files can be copied and adapted between the two systems. The main difference is the `tools` field: CC uses an array of tool names to grant access; agnz uses a policy map `{toolName: allow|ask|deny}`.

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
model: inherit
color: blue
profile: lmstudio-devstral
tools:
  edit_file: deny
  write_file: deny
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
| `profile` | no | string | Name of an existing agnz profile. If absent, the active profile is used. |
| `model` | no | string | CC-compatible field (`inherit`/`sonnet`/`opus`/`haiku`). Stored but currently ignored — profile controls the model. |
| `color` | no | string | CC-compatible visual identifier (`blue`/`cyan`/`green`/`yellow`/`magenta`/`red`). Stored for future use. |
| `tools` | no | map `{toolName: "allow"\|"ask"\|"deny"}` | Per-tool policy override on top of the profile's `defaultPolicy`. Note: different from CC's array format. |
| `skills` | no | list | Allowlist of project-local skills the agent may load via `use_skill`. If absent, all skills are available. |
| `temperature` | no | number | Overrides the profile's `temperature` for this role. |
| `maxTurns` | no | positive integer | Overrides the profile's `maxTurns`. |
| `reviewRequired` | no | boolean | Advisory flag for the board (ADR 0004). Not yet enforced. |

### Multi-line description with `<example>` blocks

Use `|` (literal block) to preserve newlines in the description — required for CC-style `<example>` blocks:

```yaml
description: |
  Use this agent when [conditions]. Examples:

  <example>
  Context: [Scenario]
  user: "[What the user says]"
  assistant: "[How Claude should respond]"
  <commentary>
  [Why this agent fits]
  </commentary>
  </example>
```

Use `>` (folded block) when you want a simple prose description without newlines:

```yaml
description: >
  Read-heavy code investigation. Bulk reads, grep sweeps,
  summaries of large modules.
```

The parser also supports plain one-line scalars for short descriptions.

### The markdown body = system prompt

Everything after the closing `---` is the body. It is **concatenated** onto `agnz`'s default sandbox-framing prompt (not a replacement). So you don't need to re-explain things like "you are in a sandbox, your cwd is X, do not narrate" — that's already there. Use the body for what makes *this* role specific: voice, priorities, handoff rules, what "done" looks like.

Keep it in prose with concrete instructions. Avoid vague "you are helpful" language — local models are more literal than frontier models and reward precise instructions.

## The tool policy model — profile is the upper bound

For every tool, the effective policy is `strictest(profile[T], agent[T])`, with strictness ordering `deny > ask > allow`.

This cuts in two unexpected directions:

- **Agent def can only restrict.** If the profile says `edit_file: ask`, and you set `edit_file: allow` in an agent def, the effective policy is still `ask`. You cannot relax the profile from inside an agent file.
- **Profile `deny` wins absolutely.** If the profile says `bash: deny`, no agent definition can unlock it. Upgrade the profile first.
- **Agent-only tools.** If a tool appears in the agent def but not the profile's `defaultPolicy`, it gets the agent's decision (treated as if the profile said `allow`). This is how you give a role access to an optional tool the profile doesn't mention.

The rationale: the profile is the user's trust setting for the whole endpoint ("what can this model's process touch at all?"). Role definitions are never a way to expand that — only to narrow it for a specific job.

## Example roles

### researcher — read-only

```markdown
---
name: researcher
profile: lmstudio-devstral
description: >
  Read-heavy code investigation. Bulk reads, grep sweeps,
  "find everywhere X is used", summaries of large modules.
tools:
  edit_file: deny
  write_file: deny
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
profile: lmstudio-devstral
description: >
  Mechanical edits across many files — renames, format changes,
  adding a field to a type in every import site. Not for design
  work or refactoring that requires judgement.
tools:
  edit_file: ask
  write_file: ask
temperature: 0.1
---

You perform precise, mechanical edits. Before editing a file,
read it so your old_string matches exactly. Make ONE change per
turn; do not batch edits. After each change, confirm what you
changed in one sentence. Ask the user (`ask_user`) if the
instructions are ambiguous — do not guess.
```

Note the `temperature: 0.1` — editors are the one role where low entropy is worth the extra stubbornness.

### tester — runs known commands

```markdown
---
name: tester
profile: lmstudio-devstral
description: >
  Runs project tests and reports results. Knows this project's
  test commands and how to interpret their output.
---

You run `npm test` (or the project's equivalent — check
package.json first) and report back. On failure, identify the
failing test file and line if possible, and quote the exact
error message. Do not attempt to fix failures — that's not
your job; just report.
```

Note: `bash` is typically `deny` in the default profile so this role currently cannot actually run commands — it is included as an example of what a role *description* looks like for a future capability.

## Snapshot-on-spawn — what that means for you

When you call `agent_start(cwd, agent: "researcher")`, `agnz` reads the file *once*, parses it, resolves its profile, merges the effective policy, and stores the result as a **snapshot** on the thread meta. From that moment the thread is running against the snapshot — editing the file afterwards does not affect the running thread.

Implications:

- **Safe to iterate on role files without hurting in-flight threads.**
- **Confusing if you expected live reload.** If you edit `researcher.md` and wonder why the sub-agent still behaves the old way — start a fresh thread to pick up the new version.
- **The snapshot is readable.** Look at `<cwd>/.claude/agnz/threads/<id>.meta.json`'s `agentDef` field to see exactly which version of the role the thread is running against.
