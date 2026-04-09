---
name: workspace
version: 0.2.0
description: "This skill should be used when agnz needs to be configured, when a profile is missing or broken, when the user asks to 'set up agnz', 'add a profile', 'configure LM Studio or Ollama', 'check what is running', 'show the current setup', or when the current workspace state needs to be understood before spawning agents. Also load when troubleshooting why an agent failed to start, when thread status needs to be inspected, or when the user asks where agents or skills are stored."
---

# agnz workspace

`agnz` is a Claude Code plugin that exposes a locally-hosted LLM as a sandboxed sub-agent. This skill covers **setup** (pointing agnz at a local model) and **inspection** (reading what is happening in a project's workspace). For *spawning* sub-agents and *defining* agent roles, see the `agents` skill.

## Two data roots — know which is which

| Location | What lives there | Scope |
|---|---|---|
| `~/.claude/agnz/` | `profiles.json`, `thread-index.json` | User-wide — shared across all projects |
| `<cwd>/.claude/agnz/` | `workspace.json`, `threads/`, `agents/` | Per-project — lives with the code |
| `<cwd>/.claude/skills/` | Project-local skills for sub-agents | Per-project |

Override the user-wide root by setting `$AGNZ_DATA_DIR`.

## Show current setup

To see version, active profile, and all per-project paths at once:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs info [/abs/path/to/project]
```

Or use the `/agnz:info` slash command. Output includes plugin version, active profile with endpoint/model/policy, and agents/threads/skills paths with file counts.

## Setup in 30 seconds

Profiles are named `{baseUrl, apiKey, model, ...}` bundles. One *active* profile is used as the default when a thread is started.

```
/agnz:setup list                      # show profiles + active
/agnz:setup add <name>                # add or replace (interactive)
/agnz:setup use <name>                # set active
/agnz:setup test [name]               # ping baseUrl
/agnz:setup remove <name>             # delete
```

Common endpoints:

- **LM Studio** → `http://localhost:1234/v1`
- **Ollama** → `http://localhost:11434/v1`
- **OpenRouter / any OpenAI-compatible** → their `/v1` URL

The `model` field must match whatever the runtime actually serves. When unsure, run `/agnz:setup test <name>` — it lists models the endpoint reports.

## Inspecting the workspace — use Read/Glob/Grep, NOT MCP

`agnz`'s MCP tools are reserved for **live process operations**. Inspect state on disk directly:

```
Read <cwd>/.claude/agnz/workspace.json          → shared workspace metadata
Glob <cwd>/.claude/agnz/threads/*.meta.json     → one file per thread
Read <cwd>/.claude/agnz/threads/<id>.jsonl      → append-only transcript
Read <cwd>/.claude/agnz/messages.jsonl          → workspace message log
```

Thread status values: `idle`, `running`, `awaiting_input`, `stopped`, `error`. An `awaiting_input` thread has a `pending` object — `kind: "approval"` or `kind: "question"`. See the `agents` skill for resolution.

## When a profile is missing or stale

**`no active profile configured`** — run `/agnz:setup add` to create one.

**`no profile named '<x>'`** — the profile was renamed or removed. Run `/agnz:setup list` to see what's actually there.

**Stale `defaultPolicy` after plugin upgrade** — new tools added to the plugin don't retroactively appear in old profiles. Recreate the profile (`/agnz:setup remove` then `add`) to pick up the current default policy.

## Reference files

For deeper content, read the file using the base directory shown in the skill header:

- **`references/layout.md`** — full directory tree for both data roots, profile and thread meta JSON schemas, `messages.jsonl` shape, `/agnz:setup` sub-command details, troubleshooting for common setup failures.
