# agnz

**A Claude Code plugin that exposes a locally-hosted LLM (LM Studio, Ollama, any OpenAI-compatible endpoint) as a sandboxed sub-agent.**

Parent Claude talks to it over MCP. The sub-agent does the heavy file work — reading, grepping, mechanical edits — and Parent Claude only sees the distilled outcome. Same value model as the built-in `Agent` tool, but the model is one *you* control and host.

## Why

- **Save tokens.** Use a free local model for grunt work instead of burning Anthropic credits on dozens of intermediate file reads.
- **Keep Parent Claude's context small.** Only the sub-agent's final answer ever lands in the parent transcript.
- **Stay in control.** The sub-agent runs inside a sandbox: locked to a single working directory, tiered permissions (read-only by default, mutating tools require approval, shell is denied).
- **Concurrency for free.** Sub-agents run in parallel via Node's event loop — no workers, no IPC. Two parallel runs measured at ~5.5s vs. ~10s sequential.

## Status (v0.2.1)

Working end-to-end and verified live against LM Studio + Devstral:

- MCP boot, `tools/list`, the full `agent_*` toolset
- `agent_start` → `agent_send` → final answer (sub-agent does `list_dir` → `read_file` → response on its own)
- Approval pause + resume via `agent_approve` (with `persist=true` to upgrade the policy for the rest of the thread)
- `ask_user` pause + resume via `agent_answer`
- Two parallel sub-agents finishing concurrently
- Profiles, project + global memory, thread persistence in a version-stable XDG data dir

**Zero npm dependencies.** The MCP stdio server is hand-rolled (~150 lines). The plugin ships as pure source — Claude Code copies it to its cache on every install and there is no `npm install` step.

## Architecture at a glance

```
Claude Code (Parent)
    │
    ▼  MCP stdio JSON-RPC
mcp/server.mjs        ← exposes the agent_* tools
    │
    ▼
agent/loop.mjs        ← LLM ↔ tool loop, persists transcript
    │
    ├──▶ tools/       (read_file, edit_file, write_file, grep, list_dir, ask_user)
    ├──▶ sandbox.mjs  (cwd lock + tiered permission policy)
    ├──▶ threads.mjs + memory.mjs   (persistence)
    ├──▶ profiles.mjs                (named LLM endpoint configs)
    └──▶ llm/openai-compatible.mjs   (native fetch, no SDK)
```

For the deep dive — module map, agent loop, detach/wait model, sandbox semantics — see [`CLAUDE.md`](./CLAUDE.md).

## Install

This is a plugin repo, not a marketplace. Install it via your local marketplace pointing at this directory, then in Claude Code:

```
/plugin marketplace update agnz
/plugin install agnz@agnz
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

Persistence lives in `$AGNZ_DATA_DIR` (default: `~/.local/share/agnz`). Intentionally version-independent so that threads, profiles, and memory survive plugin upgrades.

```
~/.local/share/agnz/
├── profiles.json
├── memory/
│   ├── global.md
│   └── projects/<hash>.md
└── threads/
    ├── <thread-id>.meta.json
    └── <thread-id>.jsonl
```

## Roadmap — where this is going

The current build is a working foundation. The direction from here:

- **Todo-list tool.** Give the sub-agent its own task list so it can break work into steps, track progress mid-run, and report a structured outcome instead of a free-form summary.
- **Skills.** Reusable, named capability bundles the sub-agent can load on demand — same idea as Claude Code's skills, but scoped to the sub-agent.
- **Messaging.** A channel for the parent and the sub-agent (and eventually sub-agents to each other) to exchange messages mid-run without tearing down the loop.
- **Multi-agents / teams.** Named sub-agents with different profiles and roles, coordinated by the parent. The concurrency primitives are already in place (`run-tracker.mjs`, parallel `kick`s verified) — this is about making it ergonomic to spin up a team and have them collaborate. E.g. one cheap model doing bulk reads, a stronger one doing the writes.
- **`bash` tool, sandboxed.** The biggest gap. Without it the sub-agent can't run tests, use git, or invoke build tools — which limits realistic use. Will be gated behind `ask` at minimum, with an allow-list and a `deny`-by-default policy for destructive operations.
- **Sub-agent self-write to memory.** A `remember(note)` tool so the sub-agent can persist learnings to project/global memory itself, instead of only via the parent.
- **Streaming / progress events.** Today `agent_send` returns one outcome at a time. Some way to surface intermediate progress without forcing the parent to poll. (Not via an outbox channel — the bar is "the sub-agent should just work and report at the end" unless there is a real reason to break that.)
- **Slash commands beyond `/agnz:setup`.** `/agnz:threads`, `/agnz:memory` for inspecting state from the parent without round-tripping through MCP tool calls.
- **Tests.** Real `node:test` coverage for the sandbox path-escape protection, the loop's drain/resume logic, and the three memory scopes.
- **License.** Pick one before publishing more widely.

## Conventions

- **Native Node only.** No npm dependencies in the plugin.
- **Comments explain *why*, not what.**
- **JSONL for streams, JSON for snapshots.** Thread transcripts are append-only; thread metadata is rewritten in place.
- **The data dir is version-stable on purpose.** Don't move it under the plugin cache.

## License

Not yet chosen. Treat as "all rights reserved" until a LICENSE file lands.
