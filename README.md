# agnz

**A Claude Code plugin that exposes a locally-hosted LLM (LM Studio, Ollama, any OpenAI-compatible endpoint) as a sandboxed sub-agent.**

Parent Claude drives it through the `agnz` CLI (from Bash). The sub-agent does the heavy file work — reading, grepping, mechanical edits — and Parent Claude only sees the distilled outcome. Same value model as the built-in `Agent` tool, but the model is one *you* control and host.

## Why

- **Save tokens.** Use a free local model for grunt work instead of burning Anthropic credits on dozens of intermediate file reads.
- **Keep Parent Claude's context small.** Only the sub-agent's final answer ever lands in the parent transcript.
- **Stay in control.** The sub-agent runs inside a sandbox: locked to a single working directory, tiered permissions defined by the agent definition.
- **Real concurrency, no daemon.** Each run is its own short-lived OS process (a detached runner) — nothing stays resident between runs, and multiple agents run in genuine parallel.

## The CLI

There is no MCP server. The parent calls the CLI via Bash; every verb prints a JSON object/array to stdout so the outcome is parseable. The binary lives at `$CLAUDE_PLUGIN_ROOT/bin/agnz.mjs`.

| Verb | Purpose |
|---|---|
| `start <name> ["task"] --agent <def>` | Create a thread (`--inline "<frontmatter>"` for an ad-hoc role). Without a task it starts idle. |
| `send <name\|id> "msg"` | Send a task. **Reuses** the existing live thread of that name (resume), else needs an id. |
| `approve <id> allow\|deny [--persist]` | Resolve an approval pause (no `tool_call_id` needed — the thread's pending call is used). |
| `answer <id> "text"` | Resolve an `AskUser` question pause. |
| `interrupt <id> ["directive"]` | Hard-interrupt a runaway/working agent: aborts the current step, leaves it resumable, optionally queues a directive. |
| `stop <id>` | End a thread (kills its runner; transcript persists). |
| `list [--status <s>] [--all]` | List threads in this workspace. |
| `show <id>` | Thread state + last few transcript messages. |

Add `--wait` to `start`/`send`/`approve`/`answer` to run the segment synchronously and get the outcome inline (for short tasks). Otherwise the run is detached and the result reaches the parent via the message hook: the runner appends to `messages.jsonl`, and the `UserPromptSubmit` hook injects unread parent mail into your next prompt automatically (an OS notification fires for urgent mail). Anything else — inspecting transcripts — is a plain file read under `<cwd>/.claude/agnz/`, or the `/agnz:threads` skill.

## Architecture at a glance

```
Claude Code (Parent)
    │  Bash
    ▼
bin/agnz.mjs            ← CLI: start/send/approve/answer/stop/interrupt/list/show
    │  spawns a detached runner per active run
    ▼
lib/runner.mjs → lib/loop.mjs   ← LLM ↔ tool loop, persists transcript, then exits
    │
    ├──▶ tools/         (Read, Edit, Write, Grep, LS, Bash, AskUser, SendMessage, Skill)
    ├──▶ sandbox.mjs    (cwd lock + tiered permission policy)
    ├──▶ agent-defs.mjs (named roles from .claude/agents/ and plugin agents/)
    ├──▶ workspace-store (<cwd>/.claude/agnz/ — threads, workspace.json)
    ├──▶ thread-index   (user-wide id → cwd map)
    ├──▶ proc-lock.mjs  (cross-process mkdir locks on shared state files)
    ├──▶ profiles.mjs   (named LLM endpoint configs, user-wide)
    └──▶ llm/openai-compatible.mjs  (native fetch, no SDK)
```

Results flow back independently of the CLI process via `messages.jsonl` + the `UserPromptSubmit` hook. For the deep dive — module map, agent loop, sandbox semantics — see [`CLAUDE.md`](./CLAUDE.md) and [ADR 0014](./docs/adr/0014-cli-replaces-mcp.md).

## What the agent sees

Each turn the agent receives a system prompt composed of:

1. **Sandbox framing** — cwd, tool workflow rules (Grep before Read, Read before Write — ADR 0013), messaging instructions
2. **CLAUDE.md files** — `<cwd>/CLAUDE.md` at startup; subdirectory `CLAUDE.md` files are added as the agent accesses files in those directories
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

Installing wires the hooks (result delivery + spend summary), the bundled agents, and the skills. The parent invokes the CLI via Bash; verify with:

```bash
node "$CLAUDE_PLUGIN_ROOT/bin/agnz.mjs" list
```

After code changes, update in place: `/plugin marketplace update agnz && /plugin install agnz@agnz && /reload-plugins`.

## Configure a profile (example)

Run `/agnz:setup add` for interactive setup, or pass all fields directly. For LM Studio (default endpoint `http://localhost:1234/v1`):

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/agnz-setup/scripts/companion.mjs setup add \
  lmstudio-devstral \
  http://localhost:1234/v1 \
  mistralai/devstral-small-2-2512
```

Profile resolution at thread start: `workspace.json → modelProfileMappings[model]` → fallback to `_default`. Configure with `/agnz:setup`.

## Agent definitions

Any Claude Code agent `.md` file works as an agnz agent definition. Pass `--agent <name>` to `agnz start`; the def is resolved from `<cwd>/.claude/agents/`, `~/.claude/agents/`, then the plugin-bundled `agents/` directory (first match wins).

Plugin-bundled defaults: `dev`, `researcher`, `reviewer`, `general`.

The `tools:` frontmatter field lists tools that run without approval. Anything not listed requires `agnz approve`. `disallowedTools:` blocks tools entirely.

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
| `agnz` | — | Progressive-disclosure reference for agent definitions and the CLI lifecycle |

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

Tests: `node --test tests/*.test.mjs` (the loop runs against an injectable fake LLM, no
model needed). Full guide: [`docs/observability.md`](./docs/observability.md).

## Conventions

- **Native Node only.** No npm dependencies.
- **Comments explain *why*, not what.**
- **JSONL for streams, JSON for snapshots.** Transcripts are append-only; thread meta is rewritten in place.
- **Two data roots, two lifetimes.** User-wide under `~/.claude/agnz/` for cross-project state. Per-project under `<cwd>/.claude/agnz/` for workspace state.

## ADRs

Design decisions are captured as ADRs under [`docs/adr/`](./docs/adr/) — authoritative descriptions of how the system works right now. The CLI architecture is [ADR 0014](./docs/adr/0014-cli-replaces-mcp.md); observability/evals, context management, and tool-workflow discipline are ADRs 0011–0013.

## License

MIT
