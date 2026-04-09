# agnz — Sandboxed local-model agent for Claude Code

A Claude Code plugin that exposes a **locally-hosted LLM** (LM Studio, Ollama, etc.) as a sandboxed sub-agent. Parent Claude talks to it via MCP. The sub-agent does the heavy file work; Parent Claude orchestrates and only sees the distilled outcome — keeping its context window small.

This file is the in-repo guidance for future Claude sessions working on the codebase. It reflects the current state of `main`: ADR 0001 (workspace-first), ADR 0002 (mailbox communication), and ADR 0003 (agent definitions) are implemented. ADR 0004 (board) is still design-in-progress. All ADRs live in [`docs/adr/`](./docs/adr/) — see the ADR section at the bottom.

## Why this exists

- Use a free/local model for grunt work (read-heavy file inspection, mechanical edits, code search) instead of burning Anthropic tokens
- Parent Claude's context only grows by the sub-agent's *final answer*, not by the dozens of intermediate file reads
- Sandbox enforces a single working directory + tiered permissions. The sub-agent cannot escape its `cwd`, cannot run arbitrary commands by default
- Multi-agent: by design, sub-agents run concurrently (Node event-loop scheduling — no workers, no IPC). Foundation for a "team of locally-hosted agents" as the workspace model fills in.

## High-level architecture

```
Claude Code (Parent)
    │
    ▼  MCP stdio JSON-RPC
mcp/server.mjs          ← 6 agent_* lifecycle tools
    │
    ▼
agent/loop.mjs          ← LLM ↔ tool loop, persists transcript
    │
    ├──▶ tools/         (read_file, edit_file, write_file, grep, list_dir, ask_user)
    ├──▶ sandbox.mjs    (cwd lock + permission policy)
    ├──▶ workspace-store.mjs  (per-project state under <cwd>/.claude/agnz/)
    ├──▶ thread-index.mjs     (user-wide thread_id → cwd map)
    ├──▶ threads.mjs          (thread lifecycle on top of workspace-store)
    ├──▶ profiles.mjs         (named LLM endpoint configs, user-wide)
    └──▶ llm/openai-compatible.mjs   (native fetch, no SDK)
```

**Zero dependencies.** No `node_modules`. We hand-wrote a minimal MCP stdio server (`mcp/jsonrpc.mjs`, ~150 lines) instead of using `@modelcontextprotocol/sdk`. The plugin ships as pure source files. Don't reintroduce npm deps without a very good reason — Claude Code copies the plugin to its cache on every install and there is no `npm install` step in that flow.

## Module map

| Path | Role |
|---|---|
| `mcp/server.mjs` | MCP server entrypoint. Defines the 6 lifecycle `agent_*` tools (start, send, wait, approve, answer, stop), their schemas, handlers. |
| `mcp/jsonrpc.mjs` | Hand-rolled JSON-RPC 2.0 stdio server (no SDK dep). |
| `agent/loop.mjs` | The agent loop. `runThread(ctx)` is the main entry. Handles new messages, resume from pause, drain leftover tool calls, and drains the mailbox (ADR 0002) at the top of every turn — delivering messages addressed to `agentName` as synthetic user messages and advancing `inboxCursor`. |
| `agent/sandbox.mjs` | Path resolution, symlink-escape protection, tiered permission policy. `defaultPolicy()` is the source of truth for tool tiers. |
| `agent/threads.mjs` | Thread lifecycle routed through a per-project workspace store. Status enum: `idle`, `running`, `awaiting_input`, `stopped`, `error`. Creates a workspace store for the thread's cwd and registers the id in the thread index. |
| `agent/workspace-store.mjs` | Owns per-project state under `<cwd>/.claude/agnz/`. Today: `workspace.json` (shared metadata, initialised on first thread) and `threads/` (meta + jsonl transcripts). Still the future home for board fields (ADR 0004). |
| `agent/messages-log.mjs` | Durable append-only `messages.jsonl` at the workspace root. `appendMessage`, `readMessagesSince(cursor)`, `readAllMessages`. Monotonic `m000001`-style ids. Per-workspace append mutex so concurrent `publish()` calls cannot race on id allocation. |
| `agent/event-bus.mjs` | In-process pub/sub. `subscribe`/`unsubscribe`/`publish(cwd, message)`. `publish` appends to the durable log first, then fans out to matching direct subscribers and any `"*"` broadcasters. Fires an OS notification via `notifier.mjs` when a message is `urgent` and addressed to `parent`. |
| `agent/notifier.mjs` | Platform-specific OS notification shim (ADR 0002 §6c). macOS uses `osascript` with AppleScript-escaped title/body; Linux uses `notify-send`; other platforms are silent no-ops. `spawn` (never `exec`), detached, fire-and-forget — a missing command never throws out of `notify()`. |
| `agent/thread-index.mjs` | User-wide `{threadId → cwd}` map at `~/.claude/agnz/thread-index.json`. Needed because MCP tools take only a `thread_id` but the actual files live under the project's cwd — the index resolves the id back to the right workspace store. |
| `agent/data-dir.mjs` | Resolves two data roots. `resolveUserDir()` returns `~/.claude/agnz/` by default (overridable by `$AGNZ_DATA_DIR`, with a transitional read-fallback to `~/.local/share/agnz/`). `resolveProjectDir(cwd)` returns `<cwd>/.claude/agnz/`. |
| `agent/profiles.mjs` | Named `{baseUrl, apiKey, model, temperature, defaultPolicy, ...}` bundles. User-wide. CRUD + ping test. |
| `agent/run-tracker.mjs` | In-memory `Map<threadId, Promise>` for the detach/wait model. Two functions: `kick`, `wait`. |
| `agent/llm/openai-compatible.mjs` | Native-fetch HTTP client for `/v1/chat/completions`. Works with LM Studio, Ollama, OpenRouter, anything OpenAI-compatible. |
| `agent/tools/registry.mjs` | Tool registry. Wraps tool descriptors, serialises to OpenAI `tools[]` schema. |
| `agent/tools/{list_dir,read_file,grep}.mjs` | Read-only tools. Default policy `allow`. |
| `agent/tools/{edit_file,write_file}.mjs` | Mutating tools. Default policy `ask`. |
| `agent/tools/ask_user.mjs` | Special tool: never actually executed; the loop intercepts it in `dispatchToolCall` and pauses with `kind="question"`. |
| `agent/tools/send_message.mjs` | The sub-agent's one publishing tool under ADR 0002. Validates the fixed `kind` vocabulary (say/question/answer/handoff/status/error/directive), normalizes `to` as string-or-array, delegates to `event-bus.publish`. Default policy `allow`. |
| `agent/agent-defs.mjs` | ADR 0003 loader. Parses the tiny YAML-frontmatter subset used by agent-def files (`<cwd>/.claude/agnz/agents/*.md`) — zero-dep, supports scalars, folded `>` block, one-level `tools:` map. Exports `parseAgentDefSource`, `validateAgentDef`, `mergeEffectivePolicy` (profile is upper bound, strictest of profile/agent wins with deny > ask > allow), `loadAgentDef`, `listAgentDefs`. Consumed by `mcp/server.mjs` at `agent_start` time and snapshotted onto the thread meta. |
| `scripts/companion.mjs` | Slash-command dispatcher. Currently only handles `/agnz:setup`. |
| `scripts/hooks/{user-prompt-submit,session-start}.mjs` + `_lib.mjs` | Opt-in Claude Code hooks for ADR 0002 §6a/6b. Inject unread `to:parent` messages into Claude's context at prompt/session time and advance the parent cursor. Self-contained — no imports from `agent/`. Fast no-op when the current project has no agnz workspace. |
| `commands/setup.md` | The `/agnz:setup` slash command markdown. |
| `skills/workspace/` | Progressive-disclosure skill covering `/agnz:setup` + workspace inspection. `SKILL.md` is the lean entry (third-person trigger phrases, ~570 words); `references/layout.md` has the full data-root layout, JSON schemas, and setup troubleshooting. |
| `skills/agents/` | Progressive-disclosure skill for ADR 0003 agent definitions and the `agent_*` lifecycle. `SKILL.md` covers when to delegate + quick define-and-spawn path; `references/defining.md` is the frontmatter field reference with example roles; `references/lifecycle.md` is the full MCP tool + conversation reference. |
| `.mcp.json` | Tells CC how to spawn the MCP server. Uses `${CLAUDE_PLUGIN_ROOT}` (verified to expand). |
| `.claude-plugin/plugin.json` | Plugin manifest. |

`agent/memory.mjs` **was deleted** as part of the 0.4.0 refactor. There is no project-memory or global-memory `.md` scope any more. If a future design needs persistent cross-run context for a workspace, it goes into `workspace.json` (per ADR 0001) or into board item notes (per ADR 0004), not into a parallel memory store.

Repo layout follows the standard Claude Code plugin layout: `.claude-plugin/plugin.json` at the root, with `agent/`, `mcp/`, `commands/`, `scripts/`, `docs/` as siblings. This repo is a **pure plugin repo** — no marketplace manifest. The marketplace lives elsewhere.

- `tmp/` — gitignored scratch dir for live tests with the sub-agent
- `docs/adr/` — Architecture Decision Records (see bottom of this file)

## The current MCP tool surface

Six tools, all about things the parent cannot do by reading files itself:

| Tool | Purpose |
|---|---|
| `agent_start` | Create a thread locked to a cwd. Creates the workspace if needed. |
| `agent_send` | Send a message. Sync by default; `detach=true` returns immediately. |
| `agent_wait` | Block on a detached run until the next event. Multiple concurrent waits safe. |
| `agent_approve` | Resolve an approval pause (allow/deny, optional `persist`). |
| `agent_answer` | Resolve an `ask_user` pause with free text. |
| `agent_stop` | Kill a live thread. Transcripts remain. |

The old `agent_status`, `agent_list_threads`, `agent_memory_read`, `agent_memory_write`, `agent_profiles_list` are gone. Their read equivalents are just `Read`/`Grep` on files under `<cwd>/.claude/agnz/`; profile management is a slash command (`/agnz:setup`) that operates on the user-wide profile file directly.

## The agent loop in one paragraph

`runThread(ctx)` accepts either a new user message or a resume payload. It loops up to `maxTurns` (default 20): build the message array (system prompt + persisted history), call the LLM, persist the assistant message, dispatch tool calls one by one. A tool call can trigger a pause: either an *approval pause* (tool's policy is `ask`) or a *question pause* (tool name is `ask_user`). Both set thread status to `awaiting_input` with a `pending: {toolCallId, kind, ...}` payload, and return without waiting. When resumed via `agent_approve` or `agent_answer`, the loop injects a tool result for the pending call (the actual tool's output if approved, a denial message if denied, the user's answer if a question) and continues. Every turn starts with a `drainLeftoverToolCalls` pass that handles any unanswered tool calls from the previous assistant turn — important when an assistant message had multiple tool calls and one of them paused.

Note: there is no memory preamble. The thread's context is exactly `system prompt + transcript`. The sub-agent has no persistent cross-thread state today.

## Detach / wait model

This is the critical decision for parent context efficiency. `agent_send` defaults to **synchronous** (await the run, return the outcome). With `detach=true`, it returns immediately with `{status: "started"}` and the run continues in the background via `run-tracker.mjs`. Then:

- `agent_wait(thread_id, timeout_ms?)` — blocks until next event (final/pause/error). Multiple concurrent waits on the same thread are safe (promises are reusable).
- Direct file read on `<cwd>/.claude/agnz/threads/<thread_id>.meta.json` — non-blocking peek at persisted state. This replaces the old `agent_status` tool.

**Why this works without workers:** Node is single-threaded but cooperatively multitasked. While a sub-agent is `await`ing a `fetch()` to LM Studio, the event loop is free. The MCP server can serve other requests, including kicking off other sub-agents. We get real concurrency for free. Verified: two parallel sub-agents finish in ~5.5s vs ~10s sequential.

`agent_approve` and `agent_answer` also accept `detach`. So the entire interaction can be non-blocking.

## Sandbox + permissions

`createSandbox({root, policy})` returns an object with:
- `resolvePath(p)` — turns relative path into absolute, refuses to escape root, resolves symlinks against root once at construction time
- `checkPermission(toolName)` — returns `"allow"`, `"ask"`, or `"deny"`
- `recordDecision(toolName, decision)` — used by `agent_approve` with `persist=true` to upgrade a tool's policy for the rest of the thread
- `getRoot()`, `getPolicy()`

`defaultPolicy()` is the source of truth:
```js
list_dir: allow,  read_file: allow,  grep: allow,  ask_user: allow,
edit_file: ask,   write_file: ask,
bash: deny
```

`bash` doesn't exist as a tool yet. It's in the policy as a placeholder so that *if* someone adds it later, the default is to refuse — fail-safe, not fail-open.

## Persistence layout

There are now **two** independent roots.

### User-wide (`resolveUserDir()`)

Default `~/.claude/agnz/`. Overridable by `$AGNZ_DATA_DIR`. A transitional read-fallback to `~/.local/share/agnz/` applies when the new location is empty but the old XDG default has content (courtesy for 0.3.x upgrades).

```
~/.claude/agnz/
├── profiles.json            ← user-wide profile store
└── thread-index.json        ← thread_id → cwd map
```

This root holds only things that are truly user-wide and cross-project. No threads, no memory, no workspace state lives here.

### Per-project (`resolveProjectDir(cwd)`)

Always `<cwd>/.claude/agnz/`. Co-located with other Claude Code project state under `.claude/`. Editable and version-controllable by the user.

```
<cwd>/.claude/agnz/
├── workspace.json                    ← shared workspace metadata (skeleton today)
└── threads/
    ├── <thread-id>.meta.json         ← thread metadata (status, pending, policy, cwd, ...)
    └── <thread-id>.jsonl             ← append-only transcript
```

`workspace.json` today is a minimal skeleton (`schemaVersion`, `name`, `cwd`, `createdAt`, `updatedAt`, `members: []`). It is created lazily on first `agent_start` in a project. ADRs 0002 and 0004 define the fields it will grow (`items`, `mode`, `reviewRequired`) and the sibling files that will join it (`messages.jsonl`, `cursors/`, `agents/`, `scratch/`).

The old `memory/` directory is gone. The old `threads/` directory under the user-wide root is gone.

## Plugin development workflow

### Versioning rule

**Only bump `version` when pushing / publishing a release.** Day-to-day feature work on a branch keeps the current version string. A release bundles several branches' worth of work and bumps once at push time, either on the release commit or immediately before `git push`. This keeps semantic versioning meaningful instead of burning a minor number per refactor Häppchen.

The two files that must move together on a release bump:

- `.claude-plugin/plugin.json`
- `mcp/server.mjs` (the `runStdioServer` call's `version` field)

### Iterating locally against the installed plugin

CC caches each installed plugin version under `~/.claude/plugins/cache/<marketplace>/<plugin>/<VERSION>/`. Since we no longer bump for every change, reinstall via one of:

1. `/plugin marketplace update agnz && /plugin install agnz@agnz && /reload-plugins` — the marketplace updater overwrites the cached version directory in place, so the live MCP server picks up the new source after a reload.
2. If `/reload-plugins` doesn't seem to take effect, the running MCP stdio process has outlived the reload. Find and kill the `node mcp/server.mjs` process; CC respawns it with the fresh files.

`/plugin uninstall agnz` is **broken** in current CC for local marketplace plugins (it actually re-enables instead of removing). Marketplace-update + reinstall is the working path.

Verify with `/mcp` — agnz should show as connected and the `agent_*` tools visible.

## Profile setup (LM Studio example)

LM Studio default endpoint is `http://localhost:1234/v1`. After installing the plugin, run `/agnz:setup add` (interactive) or directly:
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs setup add lmstudio-devstral http://localhost:1234/v1 mistralai/devstral-small-2-2512
```
The active profile is what `agent_start` picks up if no profile is named.

## Useful commands during development

```bash
# Manually run the MCP server (for debugging — it'll wait on stdin)
AGNZ_DATA_DIR=/tmp/scratch node mcp/server.mjs

# Smoke-test JSON-RPC handshake
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}' \
              '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
              '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | AGNZ_DATA_DIR=/tmp/scratch node mcp/server.mjs
```

## Conventions

- **Native Node only.** No npm dependencies in the plugin.
- **Comments explain *why*, not what.** The code already says what it does.
- **JSONL for streams, JSON for snapshots.** Thread transcripts append-only, thread meta rewritten in place.
- **Two data roots, two lifetimes.** User-wide under `resolveUserDir()` is for cross-project personal state (profiles). Per-project under `resolveProjectDir(cwd)` is for work-in-progress state that belongs with the code. Don't cross the streams.
- **Sub-agent system prompt lives in `loop.mjs:defaultSystemPrompt`.** Tells the sub-agent: don't narrate, use `ask_user` only for genuine clarifications, give a one-paragraph factual summary at the end.

## Design-in-progress: the ADRs

Four ADRs under [`docs/adr/`](./docs/adr/) describe where this branch is going. Read them before making non-trivial changes — they are the authoritative source of truth for the refactor. Status as of this file:

- **[ADR 0001 — Workspace-first architecture.](./docs/adr/0001-workspace-first-architecture.md)** Workspace as a per-project directory; MCP shrinks to process lifecycle; parent reads state from files. **Implemented in v0.4.0.** `data-dir` user/project split, `workspace-store.mjs`, `thread-index.mjs`, `threads.mjs` rewrite, `memory.mjs` removal, MCP surface down to 6 tools. No formal schema beyond the skeleton yet.
- **[ADR 0002 — Communication: mailboxes and events.](./docs/adr/0002-communication-mailbox-and-events.md)** Event bus + per-recipient mailboxes + `messages.jsonl` + `UserPromptSubmit`/`SessionStart` hooks + OS notifications. **Implemented in v0.4.0.** New modules: `agent/messages-log.mjs` (durable log with monotonic ids and a per-workspace append mutex), `agent/event-bus.mjs` (pub/sub with append-then-fanout), `agent/notifier.mjs` (macOS/Linux OS notification shim for urgent mail addressed to parent). `agent/tools/send_message.mjs` is the sub-agent's one publishing tool — reading is automatic, the loop drains the mailbox for `agentName` at the top of every turn and injects new mail as a synthetic user message. Hook scripts live under `scripts/hooks/` (`_lib.mjs`, `user-prompt-submit.mjs`, `session-start.mjs`) and are **opt-in** — users must add them to `~/.claude/settings.json` themselves. Each hook is a fast no-op when the current project has no agnz workspace.
- **[ADR 0003 — Agent definitions.](./docs/adr/0003-agent-definitions.md)** `.md` files with YAML frontmatter under `<cwd>/.claude/agnz/agents/` that layer a role, system prompt, and tool-policy overrides on top of a profile. Referenced by name at `agent_start` time. **Implemented.** `agent/agent-defs.mjs` is the zero-dep loader; `mcp/server.mjs` accepts an `agent` parameter on `agent_start`, resolves the def, merges the effective policy via `mergeEffectivePolicy` (profile is upper bound, strictest wins), and snapshots the resolved def onto `thread.agentDef`. `agent/loop.mjs` reads the snapshot for `agentNameFor`, `maxTurns`/`temperature` overrides, and concatenates `agentDef.body` onto the default sandbox-framing system prompt. Skills under `skills/agents/` document the user-facing surface.
- **[ADR 0004 — Board: mini-scrum for shared work.](./docs/adr/0004-board-mini-scrum.md)** Kanban-style board on `workspace.json` with columns, owners, dependencies, a review gate, and a `mode: planning|executing` flag. Replaces any flat-todo concept. `board_add`/`board_move`/`board_note`/`board_assign` as sub-agent tools. **Not implemented** — `workspace.json` today has no `items`, no `mode`, no `reviewRequired`.

When implementing any of 0002–0004, follow the ADR as the spec and keep deviations visible (either an amendment in the ADR or a note in the commit message).

## Known gaps / TODO

- **No `bash` tool.** Intentional for safety; will be gated behind `ask` at minimum when added.
- **No streaming.** `agent_send` returns one outcome at a time. Intermediate progress is not observable to the parent. ADR 0002 changes this picture for agent-to-parent communication via `messages.jsonl`.
- **No tests.** Sandbox path-escape, loop drain/resume, and the new workspace-store/thread-index plumbing all need real `node:test` coverage.
- **No 0.3.x → 0.4.0 migration helper.** Users with threads under the old XDG `threads/` directory lose their in-flight runs. Only profiles are read-forwarded by `resolveUserDir()`.
- **License.** Repo has no LICENSE file. Pick one before publishing more widely.
