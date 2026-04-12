# agnz

**A Claude Code plugin that exposes a locally-hosted LLM (LM Studio, Ollama, any OpenAI-compatible endpoint) as a sandboxed sub-agent.**

Parent Claude talks to it over MCP. The sub-agent does the heavy file work — reading, grepping, mechanical edits — and Parent Claude only sees the distilled outcome. Same value model as the built-in `Agent` tool, but the model is one *you* control and host.

## Why

- **Save tokens.** Use a free local model for grunt work instead of burning Anthropic credits on dozens of intermediate file reads.
- **Keep Parent Claude's context small.** Only the sub-agent's final answer ever lands in the parent transcript.
- **Stay in control.** The sub-agent runs inside a sandbox: locked to a single working directory, tiered permissions (read-only by default, mutating tools require approval, shell is denied unless allowed by the agent def).
- **Concurrency for free.** Sub-agents run in parallel via Node's event loop — no workers, no IPC. Two parallel runs measured at ~5.5s vs. ~10s sequential.

## Status (v0.9.10)

What works today:

- MCP boot, the lifecycle-only `agent_*` toolset (6 tools for agent process control)
- `agent_start(agent: "<name>")` → `agent_send` → final answer (sub-agent does work independently)
- Approval pause + resume via `agent_approve` (session-scoped, optional `persist`)
- `AskUser` pause + resume via `agent_answer`
- Detached runs via `agent_send(detach=true)` + `agent_wait`, multiple parallel sub-agents finishing concurrently
- Per-project workspace at `<cwd>/.claude/agnz/`, user-wide profiles at `~/.claude/agnz/`
- **Agent definitions** (ADR 0003) — any Claude Code agent `.md` file can be started as an agnz sub-agent. Pass `agent: "<name>"` to `agent_start`; the def is loaded from `<cwd>/.claude/agents/`, `~/.claude/agents/`, or the plugin-bundled `agents/` directory (first match wins). Plugin-bundled defaults: `dev`, `researcher`, `reviewer`, `general`.
- **modelProfileMappings** — map agent model identifiers to profile names in `workspace.json`. One profile per model, resolved at call time — no stale copies in thread meta.
- **Permissions** — tool policy is derived from the agent def's `tools:` / `disallowedTools:` frontmatter fields at runtime. Nothing stored in thread meta.
- **Skills** (ADR 0005) — project-local instruction sets at `<cwd>/.claude/skills/<name>/SKILL.md`. Sub-agents load them on demand via `Skill({action:"load", name:"..."})`. Agent defs can declare a `skills:` allowlist.
- **Mailbox communication** (ADR 0002) — sub-agents publish messages via `SendMessage`; parent Claude receives them as hook injections at prompt/session time.

**Zero npm dependencies.** The MCP stdio server is hand-rolled (~150 lines). The plugin ships as pure source — Claude Code copies it to its cache on every install and there is no `npm install` step.

## The current MCP tools

Only six, all about process lifecycle:

| Tool | Purpose |
|---|---|
| `agent_start` | Start a thread with an agent. `agent_start({agent: "name", name?: "routing-address"})`. |
| `agent_send` | Send a message. Sync by default; `detach=true` returns immediately. |
| `agent_wait` | Block on a detached run until the next event (final / pause / error). |
| `agent_approve` | Resolve an approval pause (allow/deny, optional `persist`). |
| `agent_answer` | Resolve an `AskUser` pause with a free-text answer. |
| `agent_stop` | Kill a live thread. Transcripts remain on disk. |

Anything else — inspecting a thread, listing threads, reading transcripts — the parent does by opening files under `<cwd>/.claude/agnz/threads/` directly, or via the bundled `/agnz:inspect` skill.

## Architecture at a glance

```
Claude Code (Parent)
    │
    ▼  MCP stdio JSON-RPC
mcp/server.mjs             ← 6 agent_* lifecycle tools
    │
    ▼
lib/loop.mjs               ← LLM ↔ tool loop, persists transcript
    │
    ├──▶ tools/            (Read, Edit, Write, Grep, LS, Bash,
    │                       AskUser, SendMessage, Skill)
    ├──▶ sandbox.mjs       (cwd lock + tiered permission policy)
    ├──▶ agent-defs.mjs    (named roles from .claude/agents/ and plugin agents/)
    ├──▶ workspace-store   (<cwd>/.claude/agnz/ — threads, workspace.json)
    ├──▶ thread-index      (user-wide id → cwd map)
    ├──▶ profiles.mjs      (named LLM endpoint configs, user-wide)
    └──▶ llm/openai-compatible.mjs   (native fetch, no SDK)
```

For the deep dive — module map, agent loop, detach/wait model, sandbox semantics — see [`CLAUDE.md`](./CLAUDE.md).

## Install

This repo is a plain Claude Code plugin — **not** a marketplace. Claude Code can only install plugins through a marketplace, so you first register one that lists `agnz`, then install from it. The canonical marketplace for this plugin is [`Superheld/claude-bauchladen`](https://github.com/Superheld/claude-bauchladen):

```
/plugin marketplace add Superheld/claude-bauchladen
/plugin install agnz@claude-bauchladen
/reload-plugins
```

Verify with `/mcp` — `agnz` should show as connected and the `agent_*` tools should be visible.

## Configure a profile (LM Studio example)

LM Studio's default endpoint is `http://localhost:1234/v1`. Run `/agnz:setup add` for an interactive setup, or pass all fields directly:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/agnz-setup/scripts/companion.mjs setup add \
  lmstudio-devstral \
  http://localhost:1234/v1 \
  mistralai/devstral-small-2-2512
```

Profile resolution at thread start: `workspace.json → modelProfileMappings[model]` → fallback to `modelProfileMappings["_default"]` → profile name string. Configure with `/agnz:setup`.

## Data layout

Two independent roots:

**User-wide** — profiles and cross-project settings. Default: `~/.claude/agnz/`. Override with `$AGNZ_DATA_DIR`.

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
│   ├── workspace.json       ← shared workspace metadata + modelProfileMappings
│   └── threads/
│       ├── <thread-id>.meta.json
│       └── <thread-id>.jsonl
└── skills/
    └── <name>/
        └── SKILL.md         ← project-local skills (ADR 0005)
```

Agent definitions live at `<cwd>/.claude/agents/` (the CC-standard path) — not under `agnz/`. This means the same `.md` files work for both Claude Code's built-in `Agent` tool and for agnz.

## Bundled skills

| Skill | Slash command | Purpose |
|---|---|---|
| `agnz-setup` | `/agnz:setup` | Manage LLM profiles (add, remove, use, test) |
| `agnz-info` | `/agnz:info` | Show version, data paths, active profile |
| `agnz-threads` | `/agnz:threads` | List threads in the current workspace |
| `agnz-inspect` | — | Run `inspect.sh` to dump thread meta + formatted transcript |
| `agents` | — | Progressive-disclosure reference for agent definitions and the `agent_*` lifecycle |

## Where this is going

Design decisions are captured as ADRs under [`docs/adr/`](./docs/adr/).

## Conventions

- **Native Node only.** No npm dependencies in the plugin.
- **Comments explain *why*, not what.** The code already says what it does.
- **JSONL for streams, JSON for snapshots.** Thread transcripts are append-only; thread metadata is rewritten in place.
- **Two data roots, two lifetimes.** User-wide under `~/.claude/agnz/` for cross-project personal state. Per-project under `<cwd>/.claude/agnz/` for work-in-progress state that belongs with the code.

## ADRs are living documents

The files under [`docs/adr/`](./docs/adr/) are *not* one-time decisions that get archived after implementation. They are the authoritative description of how the system works *right now* — updated whenever the implementation diverges, a tradeoff shifts, or a decision is revisited. An ADR can be amended, partially superseded, or fully replaced by a newer ADR. The current status of each ADR (proposed / implemented / superseded / rejected) is written inside the file itself.

If you change something that an ADR describes, update the ADR.

## License

MIT
