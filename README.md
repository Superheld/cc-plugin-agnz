# agnz

**A Claude Code plugin that exposes a locally-hosted LLM (LM Studio, Ollama, any OpenAI-compatible endpoint) as a sandboxed sub-agent.**

Parent Claude talks to it over MCP. The sub-agent does the heavy file work — reading, grepping, mechanical edits — and Parent Claude only sees the distilled outcome. Same value model as the built-in `Agent` tool, but the model is one *you* control and host.

## Why

- **Save tokens.** Use a free local model for grunt work instead of burning Anthropic credits on dozens of intermediate file reads.
- **Keep Parent Claude's context small.** Only the sub-agent's final answer ever lands in the parent transcript.
- **Stay in control.** The sub-agent runs inside a sandbox: locked to a single working directory, tiered permissions (read-only by default, mutating tools require approval, shell is denied).
- **Concurrency for free.** Sub-agents run in parallel via Node's event loop — no workers, no IPC. Two parallel runs measured at ~5.5s vs. ~10s sequential.

## Status (v0.5.0)

ADRs 0001–0003 and 0005 are implemented. What works today:

- MCP boot, `tools/list`, the lifecycle-only `agent_*` toolset (6 tools)
- `agent_start` → `agent_send` → final answer (sub-agent does `list_dir` → `read_file` → response on its own)
- Approval pause + resume via `agent_approve` (with `persist=true` to upgrade the policy for the rest of the thread)
- `ask_user` pause + resume via `agent_answer`
- Detached runs via `agent_send(detach=true)` + `agent_wait`, two parallel sub-agents finishing concurrently
- Per-project workspace at `<cwd>/.claude/agnz/` with threads, user-wide profiles at `~/.claude/agnz/`
- **Agent definitions** (ADR 0003) — named roles at `<cwd>/.claude/agnz/agents/<name>.md` with system prompt, profile, tool policy overrides. Pass `agent: "<name>"` to `agent_start`.
- **Skills** (ADR 0005) — project-local instruction sets at `<cwd>/.claude/skills/<name>/SKILL.md`. Sub-agents load them on demand via `use_skill`. Agent defs can declare a `skills:` allowlist.
- **Mailbox communication** (ADR 0002) — sub-agents publish messages via `send_message`; parent Claude receives them as hook injections at prompt/session time.

**Zero npm dependencies.** The MCP stdio server is hand-rolled (~150 lines). The plugin ships as pure source — Claude Code copies it to its cache on every install and there is no `npm install` step.

## The current MCP tools

Only six, all about process lifecycle:

| Tool | Purpose |
|---|---|
| `agent_start` | Create a thread locked to a cwd. |
| `agent_send` | Send a message. Sync by default; `detach=true` returns immediately. |
| `agent_wait` | Block on a detached run until the next event (final / pause / error). |
| `agent_approve` | Resolve an approval pause (allow/deny, optional `persist`). |
| `agent_answer` | Resolve an `ask_user` pause with a free-text answer. |
| `agent_stop` | Kill a live thread. Transcripts remain on disk. |

Anything else — inspecting a thread, listing threads, reading transcripts — the parent does by opening files under `<cwd>/.claude/agnz/threads/` directly.

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
    ├──▶ tools/            (read_file, edit_file, write_file, grep, list_dir,
    │                       ask_user, send_message, use_skill)
    ├──▶ sandbox.mjs       (cwd lock + tiered permission policy)
    ├──▶ agent-defs.mjs    (named roles from <cwd>/.claude/agnz/agents/)
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

LM Studio's default endpoint is `http://localhost:1234/v1`. Either run `/agnz:setup add` interactively, or:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs setup add \
  lmstudio-devstral \
  http://localhost:1234/v1 \
  mistralai/devstral-small-2-2512
```

The active profile is what `agent_start` uses when no profile is named explicitly.

## Data layout

Two independent roots:

**User-wide** — profiles and other cross-project settings. Default: `~/.claude/agnz/`. Override with `$AGNZ_DATA_DIR`. If the new location is empty but the old `~/.local/share/agnz/` has content, the old one is still read as a transitional courtesy for 0.3.x upgrades.

```
~/.claude/agnz/
├── profiles.json
└── thread-index.json        ← thread_id → cwd map
```

**Per-project** — one workspace per cwd, living under the project itself:

```
<cwd>/.claude/
├── agnz/
│   ├── workspace.json           ← shared workspace metadata
│   ├── agents/
│   │   └── <name>.md            ← agent definitions (ADR 0003)
│   └── threads/
│       ├── <thread-id>.meta.json
│       └── <thread-id>.jsonl
└── skills/
    └── <name>/
        └── SKILL.md             ← project-local skills (ADR 0005)
```

The per-project layout is co-located with other Claude Code project state under `.claude/`, and is intentionally editable and version-controllable by the user.

## Where this is going

Design decisions are captured as ADRs under [`docs/adr/`](./docs/adr/).

## Conventions

- **Native Node only.** No npm dependencies in the plugin.
- **Comments explain *why*, not what.**
- **JSONL for streams, JSON for snapshots.** Thread transcripts are append-only; thread metadata is rewritten in place.
- **User-wide data survives plugin upgrades.** Per-project data lives with the project.

## License

Not yet chosen. Treat as "all rights reserved" until a LICENSE file lands.
