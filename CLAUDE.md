# agnz — Sandboxed local-model agent for Claude Code

A Claude Code plugin that exposes a **locally-hosted LLM** (LM Studio, Ollama, etc.) as a sandboxed sub-agent. Parent Claude talks to it via MCP. The sub-agent does the heavy file work; Parent Claude orchestrates and only sees the distilled outcome — keeping its context window small.

This file is the in-repo guidance for future Claude sessions working on the codebase. It reflects the current state of `main`: ADR 0001 (workspace-first), ADR 0002 (mailbox communication), ADR 0003 (agent definitions) are implemented. ADR 0004 (board) is still design-in-progress. ADR 0005 is superseded by ADR 0006. ADRs 0006–0008 and 0010 are proposed/roadmap. ADR 0009 (tool configuration) is **partially superseded** — the `allowedCommands` workspace store approach was abandoned in favour of the simpler session-only model described below. All ADRs live in [`docs/adr/`](./docs/adr/) — see the ADR section at the bottom.

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
lib/loop.mjs          ← LLM ↔ tool loop, persists transcript
    │
    ├──▶ tools/         (LS, Read, Grep, Edit, Write, Bash, AskUser, SendMessage, Skill)
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
| `lib/loop.mjs` | The agent loop. `runThread(ctx)` is the main entry. Handles new messages, resume from pause, drain leftover tool calls, and drains the mailbox (ADR 0002) at the top of every turn — delivering messages addressed to `agentName` as synthetic user messages and advancing `inboxCursor`. |
| `lib/sandbox.mjs` | Path resolution, symlink-escape protection, tiered permission policy. `checkPermission(toolName)` returns `ask` for any tool not in the thread's policy map (built from the agent def's `tools`/`disallowedTools` fields by `buildToolPolicy` in `agent-defs.mjs`). |
| `lib/threads.mjs` | Thread lifecycle routed through a per-project workspace store. Status enum: `idle`, `running`, `awaiting_input`, `stopped`, `error`. Creates a workspace store for the thread's cwd and registers the id in the thread index. |
| `lib/workspace-store.mjs` | Owns per-project state under `<cwd>/.claude/agnz/`. Today: `workspace.json` (shared metadata, initialised on first thread) and `threads/` (meta + jsonl transcripts). Still the future home for board fields (ADR 0004). |
| `lib/messages-log.mjs` | Durable append-only `messages.jsonl` at the workspace root. `appendMessage`, `readMessagesSince(cursor)`, `readAllMessages`. Monotonic `m000001`-style ids. Per-workspace append mutex so concurrent `publish()` calls cannot race on id allocation. |
| `lib/event-bus.mjs` | In-process pub/sub. `subscribe`/`unsubscribe`/`publish(cwd, message)`. `publish` appends to the durable log first, then fans out to matching direct subscribers and any `"*"` broadcasters. Fires an OS notification via `notifier.mjs` when a message is `urgent` and addressed to `parent`. |
| `lib/notifier.mjs` | Platform-specific OS notification shim (ADR 0002 §6c). macOS uses `osascript` with AppleScript-escaped title/body; Linux uses `notify-send`; other platforms are silent no-ops. `spawn` (never `exec`), detached, fire-and-forget — a missing command never throws out of `notify()`. |
| `lib/thread-index.mjs` | User-wide `{threadId → cwd}` map at `~/.claude/agnz/thread-index.json`. Needed because MCP tools take only a `thread_id` but the actual files live under the project's cwd — the index resolves the id back to the right workspace store. |
| `lib/data-dir.mjs` | Resolves two data roots. `resolveUserDir()` returns `~/.claude/agnz/` by default (overridable by `$AGNZ_DATA_DIR`). `resolveProjectDir(cwd)` returns `<cwd>/.claude/agnz/`. |
| `lib/profiles.mjs` | Named `{baseUrl, apiKey, model, temperature, maxTurns, llmTimeoutMs, ...}` bundles. User-wide. CRUD + ping test. No `defaultPolicy` — policy comes from the agent def, not the profile. |
| `lib/run-tracker.mjs` | In-memory `Map<threadId, Promise>` for the detach/wait model. Two functions: `kick`, `wait`. |
| `lib/trace.mjs` | Append-only runtime trace. Writes `<thread-id>.trace.jsonl` alongside the transcript. Two entry types: `thread_start` (first run only — tools + system prompt) and `turn_start` (before every LLM call — current system prompt). Always fire-and-forget; failures are silent so tracing never crashes the loop. |
| `lib/llm/openai-compatible.mjs` | Native-fetch HTTP client for `/v1/chat/completions`. Works with LM Studio, Ollama, OpenRouter, anything OpenAI-compatible. |
| `lib/tools/registry.mjs` | Tool registry. Wraps tool descriptors, serialises to OpenAI `tools[]` schema. |
| `lib/tools/{LS,Read,Grep}.mjs` | Read-only tools. |
| `lib/tools/{Edit,Write}.mjs` | Mutating tools. |
| `lib/tools/Bash.mjs` | Shell execution via `/bin/sh -c` inside the sandbox cwd. Hard limits: 30 s default timeout and 1 MiB output cap — oversized stdout/stderr triggers SIGKILL and a `content: "Error: ..."` result. |
| `lib/tools/AskUser.mjs` | Special tool: never actually executed; the loop intercepts it in `dispatchToolCall` and pauses with `kind="question"`. |
| `lib/tools/SendMessage.mjs` | The sub-agent's one publishing tool under ADR 0002. Validates the fixed `kind` vocabulary (say/question/answer/handoff/status/error/directive), normalizes `to` as string-or-array, delegates to `event-bus.publish`. |
| `lib/tools/Skill.mjs` | Framework tool. Provides `list` (catalog) and `load` (full body) actions for project-local skills at `<cwd>/.claude/skills/<name>/SKILL.md`. Auto-allowed when the agent def has `skills:` set. |
| `lib/agent-defs.mjs` | ADR 0003 loader. Loads agent files from CC standard paths: `~/.claude/agents/*.md` (user), `<cwd>/.claude/agents/*.md` (project), `<pluginRoot>/agents/*.md` (plugin-bundled, lowest priority). Zero-dep parser supporting both **CC native format** (preferred) and legacy YAML block forms. Exports `parseAgentDefSource`, `validateAgentDef`, `buildToolPolicy`, `loadAgentDef`, `listAgentDefs`. Consumed by `mcp/server.mjs` at `agent_start` time and snapshotted onto the thread meta. |
| `scripts/companion.mjs` | Slash-command dispatcher. Handles `/agnz:setup` and `/agnz:info`. |
| `scripts/hooks/{user-prompt-submit,session-start}.mjs` + `_lib.mjs` | Claude Code hook scripts for ADR 0002 §6a/6b. Inject unread `to:parent` messages into Claude's context at prompt/session time and advance the parent cursor (via atomic tmp+rename after stdout drain, so the cursor never advances past messages that didn't reach Claude). Self-contained — no imports from `lib/`. Fast no-op when the current project has no agnz workspace. Wired into Claude Code via `hooks/hooks.json` — auto-enabled when the plugin is installed; scoped to the plugin's lifetime. |
| `hooks/hooks.json` | Plugin-level hook manifest. Merges into the user's Claude Code hooks when the plugin is enabled, binding `UserPromptSubmit` and `SessionStart` to the `scripts/hooks/*.mjs` scripts with a 5 s timeout. Uses the `{description, hooks: {...}}` wrapper format per plugin-dev guidance. |
| `agents/` | Plugin-bundled agent definitions (dev, researcher, reviewer, general). Loaded at lowest priority — project and user agents shadow them. |
| `skills/agnz-setup/` | Skill for `/agnz:setup` profile management. |
| `skills/agnz-info/` | Skill for `/agnz:info` — version, data paths, active profile. |
| `skills/agnz-threads/` | Skill for listing threads in the current workspace. |
| `skills/agnz-inspect/` | Skill + bash script (`scripts/inspect.sh`) for inspecting thread meta and transcript directly from disk. No MCP call needed. |
| `skills/agents/` | Progressive-disclosure skill for ADR 0003 agent definitions and the `agent_*` lifecycle. `SKILL.md` covers when to delegate + quick define-and-spawn path; `references/defining.md` is the frontmatter field reference; `references/lifecycle.md` is the full MCP tool + conversation reference. |
| `.mcp.json` | Tells CC how to spawn the MCP server. Uses `${CLAUDE_PLUGIN_ROOT}` (verified to expand). |
| `.claude-plugin/plugin.json` | Plugin manifest. |

`lib/memory.mjs` **was deleted** as part of the 0.4.0 refactor. There is no project-memory or global-memory `.md` scope any more. If a future design needs persistent cross-run context for a workspace, it goes into `workspace.json` (per ADR 0001) or into board item notes (per ADR 0004), not into a parallel memory store.

Repo layout follows the standard Claude Code plugin layout: `.claude-plugin/plugin.json` at the root, with `lib/`, `mcp/`, `commands/`, `scripts/`, `hooks/`, `docs/`, `skills/` as siblings. This repo is a **pure plugin repo** — no marketplace manifest. The marketplace lives elsewhere.

- `tmp/` — gitignored scratch dir for live tests with the sub-agent (created on demand)
- `docs/adr/` — Architecture Decision Records (see bottom of this file)
- `docs/examples/` — runnable example scripts against the library modules; see `dogfood-two-agents.mjs` for an end-to-end ADR 0002 communication smoke test

## The current MCP tool surface

Six tools, all about things the parent cannot do by reading files itself:

| Tool | Purpose |
|---|---|
| `agent_start` | Create a named agent thread. Requires `name` (routing address) and either `agent` (def name) or `inline` (frontmatter string). `cwd` is derived from server env. |
| `agent_send` | Send a message. Sync by default; `detach=true` returns immediately. |
| `agent_wait` | Block on a detached run until the next event. Multiple concurrent waits safe. |
| `agent_approve` | Resolve an approval pause (allow/deny, optional `persist`). |
| `agent_answer` | Resolve an `ask_user` pause with free text. |
| `agent_stop` | Kill a live thread. Transcripts remain. |

The old `agent_status`, `agent_list_threads`, `agent_memory_read`, `agent_memory_write`, `agent_profiles_list` are gone. Their read equivalents are just `Read`/`Grep` on files under `<cwd>/.claude/agnz/`; profile management is a slash command (`/agnz:setup`) that operates on the user-wide profile file directly.

All six tools return structured JSON via an `outputSchema` declaration — `mcp/server.mjs` has one shared `OUTCOME_SCHEMA` for the four tools that go through `formatOutcome()` (send/wait/approve/answer) and per-tool schemas for `agent_start` and `agent_stop`. The `jsonResult()` helper emits both a plain-text `content` fallback and `structuredContent` so MCP 2025-06-18 clients can validate.

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
- `recordDecision(toolName, decision)` — used by `agent_approve` with `persist=true` to upgrade a non-Bash tool's policy for the rest of the thread (session-scoped, in-memory only)
- `getRoot()`, `getPolicy()`

**Policy model — single source of truth: the agent def frontmatter.**

| Frontmatter | Result |
|---|---|
| `tools: [Read, Grep]` | `allow` — runs without asking |
| `disallowedTools: [Edit]` | `deny` — always blocked |
| not mentioned | `ask` — approval required |
| `skills:` set + Skill not denied | `allow` — auto-allowed for skill loading |

No profile `defaultPolicy`, no workspace lists. `buildToolPolicy(agentDef, availableTools)` in `agent-defs.mjs` is the only place this is computed, at thread-creation time.

**Bash is special** — an additional layer of session-scoped command tracking sits on top of the tool-level policy. When Bash is `ask` and a command has been previously approved in this thread, it runs silently. Commands are stored in `thread.meta.json` → `sessionCommands.{sessionAllow,sessionDeny}`. Use `persist=true` on `agent_approve` to save the command to the session list; without it the approval is one-time only.

Tool names are PascalCase, matching Claude Code's built-in tool naming so agent definition files can be shared between CC and agnz without modification.

`Bash` runs `/bin/sh -c <command>` inside the sandbox cwd with a 30 s default timeout and a 1 MiB cap on stdout/stderr (oversized output SIGKILLs the child).

## Persistence layout

There are now **two** independent roots.

### User-wide (`resolveUserDir()`)

Default `~/.claude/agnz/`. Overridable by `$AGNZ_DATA_DIR`.

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
    ├── <thread-id>.meta.json         ← thread metadata (status, pending, agentDef, ...)
    └── <thread-id>.jsonl             ← append-only transcript
```

`workspace.json` today is a minimal skeleton (`schemaVersion`, `name`, `cwd`, `createdAt`, `updatedAt`). It is created lazily on first `agent_start` in a project. ADRs 0002 and 0004 define the fields it will grow (`items`, `mode`, `reviewRequired`) and the sibling files that will join it (`messages.jsonl`, `cursors/`, `scratch/`). Agent definitions live in CC's standard locations (`~/.claude/agents/` and `<cwd>/.claude/agents/`), not under `agnz/`.

The old `memory/` directory is gone. The old `threads/` directory under the user-wide root is gone.

## Plugin development workflow

### Branching

Day-to-day work (bugfixes, refactoring, new features) lives on the `dev` branch. `main` is release-only — merge `dev` → `main` at release time, then bump the version and push. Never commit directly to `main` except for hotfixes that need to ship immediately.

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
Profile resolution at thread start: `workspace.json → modelProfileMappings[agentDef.model]` → fallback to `modelProfileMappings["_default"]` → profile name string. Configure mappings via `/agnz:setup`.

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
- **Sub-agent prompts live in `lib/prompts.mjs`** (`INSTRUCTIONS`, `SANDBOX_FRAMING`, `AVAILABLE_TOOLS`, `DENIED_TOOLS`, `SKILLS_HEADER`).

## Design-in-progress: the ADRs

Ten ADRs under [`docs/adr/`](./docs/adr/) document the architecture. Read them before making non-trivial changes — they are the authoritative source of truth. Status as of this file:

- **[ADR 0001 — Workspace-first architecture.](./docs/adr/0001-workspace-first-architecture.md)** Workspace as a per-project directory; MCP shrinks to process lifecycle; parent reads state from files. **Implemented in v0.4.0.** `data-dir` user/project split, `workspace-store.mjs`, `thread-index.mjs`, `threads.mjs` rewrite, `memory.mjs` removal, MCP surface down to 6 tools. No formal schema beyond the skeleton yet.
- **[ADR 0002 — Communication: mailboxes and events.](./docs/adr/0002-communication-mailbox-and-events.md)** Event bus + per-recipient mailboxes + `messages.jsonl` + `UserPromptSubmit`/`SessionStart` hooks + OS notifications. **Implemented in v0.4.0.** New modules: `lib/messages-log.mjs` (durable log with monotonic ids and a per-workspace append mutex), `lib/event-bus.mjs` (pub/sub with append-then-fanout), `lib/notifier.mjs` (macOS/Linux OS notification shim for urgent mail addressed to parent). `lib/tools/send_message.mjs` is the sub-agent's one publishing tool — reading is automatic, the loop drains the mailbox for `agentName` at the top of every turn and injects new mail as a synthetic user message. Hook scripts live under `scripts/hooks/` (`_lib.mjs`, `user-prompt-submit.mjs`, `session-start.mjs`) and are wired into Claude Code via `hooks/hooks.json` — **auto-enabled** when the plugin is installed, scoped to the plugin's lifetime (disable the plugin and the hooks go away). Each hook is a fast no-op when the current project has no agnz workspace. The cursor advance uses an atomic tmp+rename after stdout drain so messages can't be silently marked delivered without reaching Claude.
- **[ADR 0003 — Agent definitions.](./docs/adr/0003-agent-definitions.md)** `.md` files with YAML frontmatter loaded from three locations (project > user > plugin-bundled). Layers a role, system prompt, and tool policy on top of a profile. Referenced by name at `agent_start` time. **Implemented.** `lib/agent-defs.mjs` is the zero-dep loader; supports CC frontmatter fields. `mcp/server.mjs` resolves the def, builds policy via `buildToolPolicy` (ask-everything default; `tools:`/`disallowedTools:` override; `Skill` auto-allow when `skills:` set), snapshots onto `thread.agentDef`. Agent body goes into the system prompt (not as a user message — doing so breaks strict-alternation models like Mistral). Plugin-bundled defaults live in `agents/`. Skills under `skills/agents/` document the user-facing surface.
- **[ADR 0004 — Board: mini-scrum for shared work.](./docs/adr/0004-board-mini-scrum.md)** Kanban-style board on `workspace.json` with columns, owners, dependencies, a review gate, and a `mode: planning|executing` flag. Replaces any flat-todo concept. `board_add`/`board_move`/`board_note`/`board_assign` as sub-agent tools. **Not implemented** — `workspace.json` today has no `items`, no `mode`, no `reviewRequired`.
- **[ADR 0005 — Skills for agents.](./docs/adr/0005-skills-for-agents.md)** **Superseded by ADR 0006.** The `Skill` tool (implemented as `lib/tools/Skill.mjs`, policy `allow`) provides `list`/`load` actions for project-local skills at `<cwd>/.claude/skills/<name>/SKILL.md`. Agent defs support a `skills:` sequence allowlist; `lib/loop.mjs` injects a skills hint when `agentDef.skills` is non-empty.

- **[ADR 0006 — MCP servers for agents.](./docs/adr/0006-mcp-for-agents.md)** Sub-agents get access to external MCP tool surfaces. **Proposed (roadmap).**
- **[ADR 0007 — Parent context.](./docs/adr/0007-parent-context.md)** How Claude sees and uses the workspace — `UserPromptSubmit` hook injects a structured workspace summary (agents, thread statuses, unread messages) so Claude knows what's running without manual file reads. **Proposed (roadmap).**
- **[ADR 0008 — Brain system.](./docs/adr/0008-brain-system.md)** Three-tier memory for agents. **Proposed (roadmap).**
- **[ADR 0009 — Tool configuration.](./docs/adr/0009-tool-configuration.md)** Agent definitions gain `preset:` (`read-only` / `standard` / `full`) and `tool_config:` keys for per-tool configuration (e.g. Bash timeout, allowedCommands). **Partially superseded.** The `allowedCommands` workspace-store approach (permanent per-agent Bash allow/deny lists in `workspace.json`) was abandoned in favour of session-only tracking in `thread.sessionCommands`. The `preset:` and `tool_config:` keys are still valid roadmap items but not yet implemented.
- **[ADR 0010 — Workspace file manager.](./docs/adr/0010-workspace-file-manager.md)** Open/close files as context state. **Proposed / Deferred.**

When implementing any ADR, follow it as the spec and keep deviations visible (either an amendment in the ADR or a note in the commit message).

## Known gaps / TODO

- **No streaming.** `agent_send` returns one outcome at a time. Intermediate progress is not observable to the parent. ADR 0002 changes this picture for agent-to-parent communication via `messages.jsonl`.
- **No tests.** Sandbox path-escape, loop drain/resume, and workspace-store/thread-index plumbing all need real `node:test` coverage.
- **Bash sessionCommands are session-scoped only.** Approved commands are not persisted across MCP server restarts. A fresh session re-asks for every command. ADR 0009's `allowedCommands` workspace lists were the planned fix but were removed for simplicity — revisit if this becomes painful.
- **License.** MIT is declared in `plugin.json` and README but no `LICENSE` file exists in the repo root yet.
