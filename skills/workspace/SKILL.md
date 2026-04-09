---
name: workspace
version: 0.1.0
description: "This skill should be used when the user asks to 'set up agnz', 'add a profile to agnz', 'configure LM Studio for agnz', 'configure Ollama for agnz', 'inspect the agnz workspace', 'check what agnz is running', 'where does agnz store things', or needs to manage local-model profiles via /agnz:setup. Covers agnz's two data roots, profile configuration, and the workspace file layout under .claude/agnz/."
---

# agnz workspace

`agnz` is a Claude Code plugin that exposes a locally-hosted LLM as a sandboxed sub-agent. This skill covers **setup** (pointing agnz at a local model) and **inspection** (reading what is happening in a project's workspace). For *spawning* sub-agents and *defining* agent roles, see the `agents` skill.

## Two data roots — know which is which

| Location | What lives there | Scope |
|---|---|---|
| `~/.claude/agnz/` | `profiles.json`, `thread-index.json` | User-wide — shared across all projects |
| `<cwd>/.claude/agnz/` | `workspace.json`, `messages.jsonl`, `threads/`, `cursors/`, `agents/` | Per-project — lives with the code |

Override the user-wide root by setting `$AGNZ_DATA_DIR`. The per-project root is always at `.claude/agnz/` under the project cwd.

## Setup in 30 seconds

Profiles are named `{baseUrl, apiKey, model, temperature, ...}` bundles. One *active* profile is used as the default when a thread is started without specifying one.

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

The `model` field must match whatever the runtime actually serves (e.g. `mistralai/devstral-small-2-2512` in LM Studio, `qwen2.5-coder:32b` in Ollama). When unsure, run `/agnz:setup test <name>` — it lists models the endpoint reports.

For full troubleshooting, endpoint quirks, and the profile file schema see [references/layout.md](references/layout.md).

## Inspecting the workspace — use Read/Glob/Grep, NOT MCP

**Important.** `agnz`'s MCP tools (`agent_start`, `agent_send`, `agent_approve`, `agent_answer`, `agent_wait`, `agent_stop`) are reserved for **live process operations**. Inspect *state on disk* directly with Read/Glob/Grep. There is no `agent_status` or `agent_list_threads` MCP tool — that is on purpose.

Typical look-around:

```
Read <cwd>/.claude/agnz/workspace.json
  → shared workspace metadata (name, members, mode, ...)

Glob <cwd>/.claude/agnz/threads/*.meta.json
  → one file per thread: status, pending, policy, agentDef snapshot

Read <cwd>/.claude/agnz/threads/<id>.jsonl
  → append-only transcript (user/assistant/tool messages)

Read <cwd>/.claude/agnz/messages.jsonl
  → durable message log across all agents in the workspace
```

Thread status field values: `idle`, `running`, `awaiting_input`, `stopped`, `error`. An `awaiting_input` thread has a `pending` object indicating whether it is waiting on an `approval` or a `question` — see the `agents` skill for how to resolve those.

For the full directory tree and per-file schema, including what `messages.jsonl` and `cursors/` look like, see [references/layout.md](references/layout.md).

## When a profile is missing or stale

When `agent_start` returns `no active profile configured` or `no profile named '<x>'`, the user has not run `/agnz:setup add` yet (or renamed it). Point them at the setup flow above.

When a profile exists but `agent_start` returns an old / narrow policy (e.g. missing a tool that should be allowed), the stored `defaultPolicy` is stale relative to the current plugin version. Recreate the profile via `/agnz:setup remove <name>` then `/agnz:setup add <name>`. This is a known rough edge.

## Additional resources

- **[references/layout.md](references/layout.md)** — full directory tree for both data roots, profile and thread meta JSON schemas, `messages.jsonl` shape, `/agnz:setup` sub-command details, and troubleshooting for common setup failures.
