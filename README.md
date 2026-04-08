# agnz

**A Claude Code plugin that exposes a locally-hosted LLM (LM Studio, Ollama, any OpenAI-compatible endpoint) as a sandboxed sub-agent.**

Parent Claude talks to it over MCP. The sub-agent does the heavy file work — reading, grepping, mechanical edits — and Parent Claude only sees the distilled outcome. Same value model as the built-in `Agent` tool, but the model is one *you* control and host.

## Why

- **Save tokens.** Use a free local model for grunt work instead of burning Anthropic credits on dozens of intermediate file reads.
- **Keep Parent Claude's context small.** Only the sub-agent's final answer ever lands in the parent transcript.
- **Stay in control.** The sub-agent runs inside a sandbox: locked to a single working directory, tiered permissions (read-only by default, mutating tools require approval, shell is denied).
- **Concurrency for free.** Sub-agents run in parallel via Node's event loop — no workers, no IPC. Two parallel runs measured at ~5.5s vs. ~10s sequential.

## Status (v0.4.0-pre)

This branch is mid-refactor toward a **workspace-first architecture** (see the ADRs below). What works today:

- MCP boot, `tools/list`, the lifecycle-only `agent_*` toolset (6 tools)
- `agent_start` → `agent_send` → final answer (sub-agent does `list_dir` → `read_file` → response on its own)
- Approval pause + resume via `agent_approve` (with `persist=true` to upgrade the policy for the rest of the thread)
- `ask_user` pause + resume via `agent_answer`
- Detached runs via `agent_send(detach=true)` + `agent_wait`, two parallel sub-agents finishing concurrently
- Per-project workspace at `<cwd>/.claude/agnz/` with threads, user-wide profiles at `~/.claude/agnz/`

What has moved or gone since 0.3.x:

- The data dir is now split. Per-project state (threads, future workspace.json, board, messages) lives under `<cwd>/.claude/agnz/`. User-wide state (profiles) lives under `~/.claude/agnz/` (with a transitional read-fallback to `~/.local/share/agnz/`).
- The MCP surface shrank from 11 tools to 6. Everything read-only (status, list threads, memory) is gone from MCP; parent Claude reads workspace state directly with its own `Read`/`Grep` tools.
- **Memory is removed.** The old project/global `.md` memory scopes no longer exist. Persistent context now belongs in the workspace itself — see ADRs 0001 and 0004.

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
agent/loop.mjs             ← LLM ↔ tool loop, persists transcript
    │
    ├──▶ tools/            (read_file, edit_file, write_file, grep, list_dir, ask_user)
    ├──▶ sandbox.mjs       (cwd lock + tiered permission policy)
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
<cwd>/.claude/agnz/
├── workspace.json           ← shared workspace metadata (skeleton today)
└── threads/
    ├── <thread-id>.meta.json
    └── <thread-id>.jsonl
```

The per-project layout is co-located with other Claude Code project state under `.claude/`, and is intentionally editable and version-controllable by the user.

## Where this is going

The design trajectory is captured in four ADRs under [`docs/adr/`](./docs/adr/). Only ADR 0001 has been partially implemented on this branch (the data-dir split, workspace store, thread index, and MCP shrink). The rest are designed but not yet built.

- **[ADR 0001 — Workspace-first architecture.](./docs/adr/0001-workspace-first-architecture.md)** Workspace as a directory under `<cwd>/.claude/agnz/`. MCP shrinks to process lifecycle. Parent reads state directly from files. *Partially implemented: user/project dir split, workspace store, thread index, 6-tool MCP surface.*
- **[ADR 0002 — Communication: mailboxes and events.](./docs/adr/0002-communication-mailbox-and-events.md)** Per-recipient mailboxes, a `messages.jsonl` durable log, an in-process event bus, and parent notification through `UserPromptSubmit` / `SessionStart` hooks plus OS notifications for urgent traffic. *Designed, not implemented.*
- **[ADR 0003 — Agent definitions.](./docs/adr/0003-agent-definitions.md)** Roles on top of profiles: `.md` files with YAML frontmatter under `<cwd>/.claude/agnz/agents/`, referenced by name at `agent_start` time. *Designed, not implemented.*
- **[ADR 0004 — Board: mini-scrum for shared work.](./docs/adr/0004-board-mini-scrum.md)** A small kanban board on `workspace.json`, replacing flat todos, with columns, owners, dependencies, a review gate, and a planning-mode flag. *Designed, not implemented.*

There is no `bash` tool today and adding one is intentionally outside the current branch.

## Conventions

- **Native Node only.** No npm dependencies in the plugin.
- **Comments explain *why*, not what.**
- **JSONL for streams, JSON for snapshots.** Thread transcripts are append-only; thread metadata is rewritten in place.
- **User-wide data survives plugin upgrades.** Per-project data lives with the project.

## License

Not yet chosen. Treat as "all rights reserved" until a LICENSE file lands.
