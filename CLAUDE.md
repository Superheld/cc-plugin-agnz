# agnz — Sandboxed local-model agent for Claude Code

A Claude Code plugin that exposes a **locally-hosted LLM** (LM Studio, Ollama, etc.) as a sandboxed sub-agent. Parent Claude talks to it via MCP. The sub-agent does the heavy file work; Parent Claude orchestrates and only sees the distilled outcome — keeping its context window small.

## Why this exists

- Use a free/local model for grunt work (read-heavy file inspection, mechanical edits, code search) instead of burning Anthropic tokens
- Parent Claude's context only grows by the sub-agent's *final answer*, not by the dozens of intermediate file reads. Same value model as the built-in `Agent` tool, but with a model the user controls
- Sandbox enforces a single working directory + tiered permissions. The sub-agent cannot escape its `cwd`, cannot run arbitrary commands by default
- Multi-agent: by design, sub-agents run concurrently (Node event-loop scheduling — no workers, no IPC). Foundation for "team of locally-hosted agents" later

## High-level architecture

```
Claude Code (Parent)
    │
    ▼  MCP stdio JSON-RPC
mcp/server.mjs    ← exposes 11 agent_* tools
    │
    ▼
agent/loop.mjs    ← LLM ↔ tool loop, persists transcript
    │
    ├──▶ tools/  (read_file, edit_file, write_file, grep, list_dir, ask_user)
    ├──▶ sandbox.mjs  (cwd lock + permission policy)
    ├──▶ threads.mjs + memory.mjs  (state persistence)
    ├──▶ profiles.mjs  (named LLM endpoint configs)
    └──▶ llm/openai-compatible.mjs  (native fetch, no SDK)
```

**Zero dependencies.** No `node_modules`. We hand-wrote a minimal MCP stdio server (`mcp/jsonrpc.mjs`, ~150 lines) instead of using `@modelcontextprotocol/sdk`. The plugin ships as pure source files. Don't reintroduce npm deps without a very good reason — Claude Code copies the plugin to its cache on every install and there's no `npm install` step in that flow.

## Module map

| Path | Role |
|---|---|
| `mcp/server.mjs` | MCP server entrypoint. Defines all `agent_*` tools, their schemas, handlers. |
| `mcp/jsonrpc.mjs` | Hand-rolled JSON-RPC 2.0 stdio server (no SDK dep). |
| `agent/loop.mjs` | The agent loop. `runThread(ctx)` is the main entry. Handles new messages, resume from pause, drain leftover tool calls. |
| `agent/sandbox.mjs` | Path resolution, symlink-escape protection, tiered permission policy. `defaultPolicy()` is the source of truth for tool tiers. |
| `agent/threads.mjs` | Thread lifecycle on top of `memory.mjs`. Status enum: `idle`, `running`, `awaiting_input`, `stopped`, `error`. |
| `agent/memory.mjs` | Persistence: thread JSONL transcripts, project memory (.md per cwd), global memory (.md). Three scopes. |
| `agent/profiles.mjs` | Named `{baseUrl, apiKey, model, temperature, defaultPolicy, ...}` bundles. CRUD + ping test. |
| `agent/run-tracker.mjs` | In-memory `Map<threadId, Promise>` for the detach/wait model. Two functions: `kick`, `wait`. |
| `agent/data-dir.mjs` | Resolves the data directory. Defaults to `~/.local/share/agnz` (XDG-style). **Critical**: this is intentionally version-INDEPENDENT so threads/profiles survive plugin updates. |
| `agent/llm/openai-compatible.mjs` | Native-fetch HTTP client for `/v1/chat/completions`. Works with LM Studio, Ollama, OpenRouter, anything OpenAI-compatible. |
| `agent/tools/registry.mjs` | Tool registry. Wraps tool descriptors, serialises to OpenAI tools[] schema. |
| `agent/tools/{list_dir,read_file,grep}.mjs` | Read-only tools. Default policy `allow`. |
| `agent/tools/{edit_file,write_file}.mjs` | Mutating tools. Default policy `ask`. |
| `agent/tools/ask_user.mjs` | Special tool: never actually executed; the loop intercepts it in `dispatchToolCall` and pauses with `kind="question"`. |
| `scripts/companion.mjs` | Slash-command dispatcher. Currently only handles `/agnz:setup`. |
| `commands/setup.md` | The `/agnz:setup` slash command markdown. |
| `.mcp.json` | Tells CC how to spawn the MCP server. Uses `${CLAUDE_PLUGIN_ROOT}` (verified to expand). |
| `.claude-plugin/plugin.json` | Plugin manifest. |

Repo layout follows the standard Claude Code plugin layout: `.claude-plugin/plugin.json` at the root, with `agent/`, `mcp/`, `commands/`, `scripts/` as siblings. This repo is a **pure plugin repo** — no marketplace manifest. The marketplace lives elsewhere.

- `tmp/` — gitignored scratch dir for live tests with the sub-agent

## The agent loop in one paragraph

`runThread(ctx)` accepts either a new user message or a resume payload. It loops up to `maxTurns` (default 20): build the message array (system prompt + memory preamble + persisted history), call the LLM, persist the assistant message, dispatch tool calls one by one. A tool call can trigger a pause: either an *approval pause* (tool's policy is `ask`) or a *question pause* (tool name is `ask_user`). Both set thread status to `awaiting_input` with a `pending: {toolCallId, kind, ...}` payload, and return without waiting. When resumed via `agent_approve` or `agent_answer`, the loop injects a tool result for the pending call (the actual tool's output if approved, a denial message if denied, the user's answer if a question) and continues. Every turn starts with a `drainLeftoverToolCalls` pass that handles any unanswered tool calls from the previous assistant turn — important when an assistant message had multiple tool calls and one of them paused.

## Detach / wait model

This is the critical decision for parent context efficiency. `agent_send` defaults to **synchronous** (await the run, return the outcome). With `detach=true`, it returns immediately with `{status: "started"}` and the run continues in the background via `run-tracker.mjs`. Then:

- `agent_wait(thread_id, timeout_ms?)` — blocks until next event (final/pause/error). Multiple concurrent waits on the same thread are safe (promises are reusable).
- `agent_status(thread_id)` — non-blocking peek at persisted state.

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

```
$AGNZ_DATA_DIR  (or ~/.local/share/agnz by default)
├── profiles.json                     ← profile store
├── memory/
│   ├── global.md                     ← global memory scope
│   └── projects/<hash>.md            ← project scope (one per cwd)
└── threads/
    ├── <thread-id>.meta.json         ← thread metadata (status, pending, policy, ...)
    └── <thread-id>.jsonl             ← message transcript (user/assistant/tool messages)
```

The data dir is **version-independent on purpose**. Earlier we made the mistake of defaulting it to a path inside the plugin (which CC re-caches per version), which orphaned threads on every plugin bump. The XDG default fixes this.

## Plugin development workflow

CC caches each installed plugin version under `~/.claude/plugins/cache/agnz/agnz/<VERSION>/`. There is no live-reload; **every code change requires a version bump and reinstall**. Cycle:

1. Edit source at the repo root (`agent/`, `mcp/`, `commands/`, ...)
2. Bump version in **both** places:
   - `.claude-plugin/plugin.json`
   - `mcp/server.mjs` (the `runStdioServer` call's `version` field)
3. In Claude Code:
   ```
   /plugin marketplace update agnz
   /plugin install agnz@agnz
   /reload-plugins
   ```
4. Verify with `/mcp` — agnz should show as connected and the `agent_*` tools should be visible.

`/plugin uninstall agnz` is **broken** in current CC for local marketplace plugins (it actually re-enables instead of removing). Bump-and-reinstall is the working path.

## Profile setup (LM Studio example)

LM Studio default endpoint is `http://localhost:1234/v1`. After installing the plugin, run `/agnz:setup add` (interactive) or directly:
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs setup add lmstudio-devstral http://localhost:1234/v1 mistralai/devstral-small-2-2512
```
The active profile is what `agent_start` picks up if no profile is named.

## Live test verified (as of 0.1.3)

1. **MCP boot + tools/list** over stdio — works
2. **`agent_start` → `agent_send` → final answer** — works (Devstral did `list_dir` → `read_file` → final response)
3. **Approval pause** — works (Devstral paused on `edit_file`, resumed via `agent_approve(persist=true)`, completed)
4. **`ask_user` pause** — works (Devstral paused on `ask_user` with `kind=question`, got answer via `agent_answer`, continued and wrote a file)
5. **Parallel sub-agents** — works (two threads, two `kick` calls, ~5.5s total wall-clock vs ~10s sequential)

## Known gaps / TODO

- **No `bash` tool** — sub-agent cannot run commands, run tests, use git. This is intentional for safety but limits realistic use. When added, gate behind `ask` at minimum.
- **No streaming** — `agent_send` returns one outcome at a time. Status updates *during* a turn aren't possible (we explicitly chose not to build polling/outbox channels — the sub-agent should just work and report at the end).
- **No `/agnz:threads`, `/agnz:memory` slash commands** — `companion.mjs` has only the `setup` group wired up.
- **No tests** — sandbox path-escape, loop drain/resume, memory scopes all need real `node:test` coverage.
- **Sub-agent self-write to memory** — currently only Parent Claude can write to project/global memory via `agent_memory_write`. The sub-agent has no `remember(note)` tool. Would be a small addition.
- **License** — repo has no LICENSE file (the old fork's MIT/whatever was deleted). Pick one before publishing.

## Useful commands during development

```bash
# Manually run the MCP server (for debugging — it'll wait on stdin)
AGNZ_DATA_DIR=/tmp/scratch node mcp/server.mjs

# Smoke-test JSON-RPC handshake
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}' \
              '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
              '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | AGNZ_DATA_DIR=/tmp/scratch node mcp/server.mjs

# E2E test scripts (if /tmp/agnz-e2e/ still exists from earlier work)
node /tmp/agnz-e2e/driver.mjs              # basic list+read+respond
node /tmp/agnz-e2e/driver-approval.mjs     # approval pause + resume
node /tmp/agnz-e2e/driver-ask.mjs          # ask_user pause + resume
node /tmp/agnz-e2e/driver-parallel.mjs    # two parallel sub-agents
```

## Conventions

- **Native Node only.** No npm dependencies in the plugin.
- **Comments explain *why*, not what.** The code already says what it does.
- **JSONL for streams, JSON for snapshots.** Thread transcripts append-only, thread meta rewritten in place.
- **Version bump ≠ data migration.** The data dir is intentionally version-stable. If a future schema change forces migration, do it explicitly in `data-dir.mjs` or a one-time helper.
- **Sub-agent system prompt lives in `loop.mjs:defaultSystemPrompt`.** Tells the sub-agent: don't narrate, use `ask_user` only for genuine clarifications, give a one-paragraph factual summary at the end.
