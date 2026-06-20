# agnz

**A Claude Code plugin that exposes a locally-hosted LLM (LM Studio, Ollama, any OpenAI-compatible endpoint) as a sandboxed sub-agent.**

> **Note (2026-06):** agnz now runs **CLI-only** — the parent drives it via `bin/agnz.mjs` (from Bash), not an MCP server. The "MCP tool surface" and architecture sections below are mid-update; see [ADR 0014](./docs/adr/0014-cli-replaces-mcp.md) and `skills/agnz/SKILL.md` for the current surface and verbs (`start`/`send`/`approve`/`answer`/`stop`/`interrupt`/`list`/`show`).

Parent Claude talks to it through the `agnz` CLI (Bash). The sub-agent does the heavy file work — reading, grepping, mechanical edits — and Parent Claude only sees the distilled outcome. Same value model as the built-in `Agent` tool, but the model is one *you* control and host.

## Why

- **Save tokens.** Use a free local model for grunt work instead of burning Anthropic credits on dozens of intermediate file reads.
- **Keep Parent Claude's context small.** Only the sub-agent's final answer ever lands in the parent transcript.
- **Stay in control.** The sub-agent runs inside a sandbox: locked to a single working directory, tiered permissions defined by the agent definition.
- **Concurrency for free.** Sub-agents run in parallel via Node's event loop — no workers, no IPC. Two parallel runs measured at ~5.5s vs. ~10s sequential.

## MCP tool surface

Two namespaces, clearly separated:

| Tool | Purpose |
|---|---|
| `agent_start` | Start a thread. Pass `agent` (def name) or `inline` (raw frontmatter string). |
| `agent_stop` | Hard-stop a running thread. Aborts the in-flight LLM call via AbortController. Transcript stays on disk. |
| `thread_send` | Send a message. Always returns immediately — agent runs in background. Idle/stopped threads resume; error threads are blocked (use `agent_start`). |
| `thread_approve` | Resolve an approval pause (allow/deny, optional `persist`). Agent resumes in background. |
| `thread_answer` | Resolve an `AskUser` question pause with a free-text answer. Agent resumes in background. |

All three `thread_*` tools return immediately. Results come back via `SendMessage(to: "parent")` — the `UserPromptSubmit` hook injects unread parent mail into your next prompt automatically. The agent also auto-notifies parent on completion, max-turns, error, and any pause — so nothing goes silently missing.

Anything else — inspecting a thread, listing threads, reading transcripts — the parent does by reading files under `<cwd>/.claude/agnz/` directly, or via the bundled `/agnz:threads` skill.

## Architecture at a glance

```
Claude Code (Parent)
    │
    ▼  MCP stdio JSON-RPC
mcp/server.mjs          ← agent_start, agent_stop, thread_send/approve/answer
    │
    ▼
lib/loop.mjs            ← LLM ↔ tool loop, persists transcript
    │
    ├──▶ tools/         (Read, Edit, Write, Grep, LS, Bash, AskUser, SendMessage, Skill)
    ├──▶ sandbox.mjs    (cwd lock + tiered permission policy)
    ├──▶ agent-defs.mjs (named roles from .claude/agents/ and plugin agents/)
    ├──▶ workspace-store (<cwd>/.claude/agnz/ — threads, workspace.json)
    ├──▶ thread-index   (user-wide id → cwd map)
    ├──▶ profiles.mjs   (named LLM endpoint configs, user-wide)
    └──▶ llm/openai-compatible.mjs  (native fetch, no SDK)
```

For the deep dive — module map, agent loop, sandbox semantics — see [`CLAUDE.md`](./CLAUDE.md).

## What the agent sees

Each turn the agent receives a system prompt composed of:

1. **Sandbox framing** — cwd, tool workflow rules, messaging instructions
2. **CLAUDE.md files** — `<cwd>/CLAUDE.md` at startup; subdirectory `CLAUDE.md` files are added as the agent accesses files in those directories (CC-style, but scoped to the sandbox)
3. **Tool restrictions** — which tools are allowed/denied per the agent def
4. **Skills catalog** — names + descriptions of available skills; agent loads full content on demand via `Skill({action:"load", name:"..."})`
5. **Agent body** — the role definition from the agent def frontmatter

## Install

This repo is a plain Claude Code plugin. The canonical marketplace is [`Superheld/claude-bauchladen`](https://github.com/Superheld/claude-bauchladen):

```
/plugin marketplace add Superheld/claude-bauchladen
/plugin install agnz@claude-bauchladen
/reload-plugins
```

Verify with `/mcp` — `agnz` should show as connected and the tools visible.

After code changes, update in place:

```
/plugin marketplace update agnz && /plugin install agnz@agnz && /reload-plugins
```

If reload doesn't take effect, the MCP process has outlived it — `pkill -f "node.*agnz.*server.mjs"` and CC will respawn it.

## Configure a profile (LM Studio example)

LM Studio's default endpoint is `http://localhost:1234/v1`. Run `/agnz:setup add` for interactive setup, or pass all fields directly:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/agnz-setup/scripts/companion.mjs setup add \
  lmstudio-devstral \
  http://localhost:1234/v1 \
  mistralai/devstral-small-2-2512
```

Profile resolution at thread start: `workspace.json → modelProfileMappings[model]` → fallback to `_default`. Configure with `/agnz:setup`.

## Agent definitions

Any Claude Code agent `.md` file works as an agnz agent definition. Pass `agent: "<name>"` to `agent_start`; the def is resolved from `<cwd>/.claude/agents/`, `~/.claude/agents/`, then the plugin-bundled `agents/` directory (first match wins).

Plugin-bundled defaults: `dev`, `researcher`, `reviewer`, `general`.

The `tools:` frontmatter field lists tools that run without approval. Anything not listed requires `thread_approve`. `disallowedTools:` blocks tools entirely.

## Data layout

Two independent roots:

**User-wide** — profiles and cross-project index. Default: `~/.claude/agnz/`. Override with `$AGNZ_DATA_DIR`.

```
~/.claude/agnz/
├── profiles.json
└── thread-index.json        ← thread_id → cwd map
```

**Per-project** — one workspace per cwd, co-located with other Claude Code state:

```
<cwd>/.claude/
├── agents/
│   └── <name>.md            ← agent definitions (shared with CC)
├── agnz/
│   ├── workspace.json       ← shared metadata + modelProfileMappings
│   ├── messages.jsonl       ← event bus for inter-agent communication
│   ├── cursors/             ← parent read-cursor state (hook delivery tracking)
│   └── threads/
│       ├── <thread-id>.meta.json
│       ├── <thread-id>.jsonl
│       └── <thread-id>.trace.jsonl
└── skills/
    └── <name>/
        └── SKILL.md         ← project-local skills
```

## Bundled skills

| Skill | Slash command | Purpose |
|---|---|---|
| `agnz-setup` | `/agnz:setup` | Manage LLM profiles (add, remove, use, test, mappings) |
| `agnz-threads` | `/agnz:threads` | List and inspect threads in the current workspace |
| `agnz` | — | Progressive-disclosure reference for agent definitions and the full tool lifecycle |

## Observability & evaluation

Every thread writes an append-only runtime trace next to its transcript
(`<thread-id>.trace.jsonl`): per-turn LLM latency + token usage, tool outcomes,
JSON-repair events, and a terminal `thread_end`. From it you get:

- **Stats** — `node ${CLAUDE_PLUGIN_ROOT}/lib/trace-stats.mjs [<thread-id>]` (or
  `inspect.sh stats`) folds the trace into turns, tokens, latency, tool-error
  and repair rates, with per-model rollups.
- **Live spend** — the `SessionStart`/`UserPromptSubmit` hooks inject a per-thread
  spend line (`dev:1a2b3c4d — running · 5 turns · 1,234 tok`) into Claude's
  context, so the parent sees what's running without reading files.
- **Evals** — `node evals/run.mjs` runs fixtures against one or more profiles in
  throwaway workspaces and scores outcome + trace metrics, ranking profiles by
  pass rate then token cost. The answer to "which local model for which role?".

Tests: `node --test tests/` (the loop runs against an injectable fake LLM, no
model needed). Full guide: [`docs/observability.md`](./docs/observability.md).

## Conventions

- **Native Node only.** No npm dependencies.
- **Comments explain *why*, not what.**
- **JSONL for streams, JSON for snapshots.** Transcripts are append-only; thread meta is rewritten in place.
- **Two data roots, two lifetimes.** User-wide under `~/.claude/agnz/` for cross-project state. Per-project under `<cwd>/.claude/agnz/` for workspace state.

## ADRs

Design decisions are captured as ADRs under [`docs/adr/`](./docs/adr/) — authoritative descriptions of how the system works right now, updated as the implementation evolves.

## License

MIT
