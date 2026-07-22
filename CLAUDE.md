# agnz — Sandboxed local-model agent for Claude Code

A Claude Code plugin that exposes a **locally-hosted LLM** (LM Studio, Ollama, etc.) as a sandboxed sub-agent. Parent Claude talks to it via a CLI (`bin/agnz.mjs`, invoked from Bash); there is no MCP server (removed — see ADR 0014). The sub-agent does the heavy file work; Parent Claude orchestrates and only sees the distilled outcome — keeping its context window small.

This file is the in-repo guidance for future Claude sessions working on the codebase. It reflects `main` after the **CLI pivot (0.13.0, ADR 0014)**: the MCP server is gone — the parent drives agnz through `bin/agnz.mjs`. **Implemented:** ADR 0001 (workspace-first), 0002 (mailbox), 0003 (agent defs), 0007 (parent context), 0011 (observability/evals), 0012 phase 1 (context management — frozen prompt prefix), 0013 (tool-workflow discipline — Grep→Read→Write), 0014 (CLI). **Roadmap:** ADR 0004 (board), 0008 (brain). 0005 superseded by 0006; 0009 partially superseded (session-only command model below). ADR 0010 (workspace file manager) was implemented then reverted — its read-before-write kernel now lives in ADR 0013 + the anchor-based Edit tool. ADRs 0001/0004/0010 are referenced but their files were never committed / were reverted. All ADRs live in [`docs/adr/`](./docs/adr/) — see the ADR section at the bottom.


## Why this exists

- Use a free/local model for grunt work (read-heavy file inspection, mechanical edits, code search) instead of burning Anthropic tokens
- Parent Claude's context only grows by the sub-agent's *final answer*, not by the dozens of intermediate file reads
- Sandbox enforces a single working directory + tiered permissions. The sub-agent cannot escape its `cwd`, cannot run arbitrary commands by default
- Multi-agent: by design, sub-agents run concurrently (separate detached OS processes — no workers, no IPC). Foundation for a "team of locally-hosted agents" as the workspace model fills in.

## High-level architecture

```
Claude Code (Parent)
    │  Bash
    ▼
bin/agnz.mjs          ← CLI: start/send/approve/answer/stop/interrupt/list/show
    │  spawns a detached runner per active run
    ▼
lib/runner.mjs → lib/loop.mjs   ← LLM ↔ tool loop, persists transcript, then exits
    │
    ├──▶ tools/         (LS, Read, Grep, Edit, Write, Bash, AskUser, SendMessage, Skill)
    ├──▶ sandbox.mjs    (cwd lock + permission policy)
    ├──▶ workspace-store.mjs  (per-project state under <cwd>/.claude/agnz/)
    ├──▶ config.mjs           (two-layer config: user defaults + project overrides)
    ├──▶ threads.mjs          (thread lifecycle on top of workspace-store)
    └──▶ llm/openai-compatible.mjs   (native fetch, no SDK)
```

**Zero dependencies.** No `node_modules` — native Node only across the CLI, runner, and loop. The plugin ships as pure source files. Don't reintroduce npm deps without a very good reason — Claude Code copies the plugin to its cache on every install and there is no `npm install` step in that flow.

## Module map

| Path | Role |
|---|---|
| `bin/agnz.mjs` | The CLI entrypoint (replaces the old MCP server — ADR 0014). Parses argv into the verbs (incl. the `wait` watcher), resolves agent defs + reuse-by-name, spawns a detached runner, prints JSON to stdout. `show` is the lean structural view — `capPending`/excerpt caps keep the payload token-bounded (ADR 0015). |
| `bin/agnz` | Thin `sh` wrapper (`exec node …/agnz.mjs "$@"`) giving a clean `agnz` command. CC puts an enabled plugin's `bin/` on the parent's `PATH`, so the parent invokes `agnz <verb>` by bare name from any cwd — no `$CLAUDE_PLUGIN_ROOT`. A wrapper (not a symlink or extensionless rename) because the repo has no `package.json "type":"module"`, so the ESM CLI must keep its `.mjs` extension. |
| `lib/runner.mjs` | Detached run process — one per active run: reads a payload, **atomically claims the thread** (`claimThread` — records its pid + flips to `running`; exits if a live runner already holds it, closing the two-runner admission race), runs `runThread` one segment, exits. State in files, results via the hook. |
| `lib/orchestrate.mjs` | Shared run helpers (`resolveProfile`, `makeSandbox`, `PLUGIN_ROOT`) used by the runner and the eval harness's inline run path (ADR 0011 §5) — the CLI-level `--wait` flag that used to share this path is gone (ADR 0015). |
| `lib/loop.mjs` | The agent loop. `runThread(ctx)` is the main entry. Handles new messages, resume from pause, drain leftover tool calls. The system prompt is a **frozen prefix** (ADR 0012 phase 1): `renderSystemPrompt` runs once on the first run and the result is snapshotted onto `thread.systemPromptSnapshot`, reused byte-identically every turn so the prefix never grows and the server can cache it. `drainTopOfTurnContext` runs at the top of every turn and injects, as a single synthetic user message, (a) one-time project-context files for newly-visited subdirs (`pendingDirMds`; per directory CLAUDE.md wins, else AGENTS.md — `readProjectMd`) and (b) new mailbox mail (ADR 0002) for `agentName`, advancing `inboxCursor`. Combined into one message so two consecutive user turns never occur. |
| `lib/sandbox.mjs` | Path resolution, symlink-escape protection, tiered permission policy. `checkPermission(toolName)` returns `ask` for any tool not in the thread's policy map (built from the agent def's `tools`/`disallowedTools` fields by `buildToolPolicy` in `agent-defs.mjs`). |
| `lib/threads.mjs` | Thread lifecycle routed through a per-project workspace store. Status enum: `idle`, `running`, `awaiting_input`, `stopped`, `error`. Creates a workspace store for the thread's cwd and registers the id in the thread index. `claimThread(id, pid)` is the runner's admission gate: an atomic read-modify-write that flips an unclaimed thread to `running` and records `runnerPid`, refusing if a live runner already holds it (liveness matches `recoverIfStale`). **The on-disk `threads/` dir is the source of truth; the user-wide index is a resolver cache that can desync from it.** `reconcileWorkspace(cwd)` dir-scans and re-registers any "ghost" (meta on disk, no index entry); `listThreads()` and the CLI's `resolveTarget`/`list` self-heal through it, so a lost index entry never hides a thread from `list`/`send`. |
| `lib/workspace-store.mjs` | Owns per-project state under `<cwd>/.claude/agnz/`. Today: `workspace.json` (shared metadata, initialised on first thread) and `threads/` (meta + jsonl transcripts). Its update helper honours a `SKIP_MUTATION` sentinel — a mutator returning it leaves the file untouched (no rewrite), which `claimThread` relies on to bail out cleanly when the thread is already claimed. Still the future home for board fields (ADR 0004). |
| `lib/messages-log.mjs` | Durable append-only `messages.jsonl` at the workspace root. `appendMessage`, `readMessagesSince(cursor)`, `readAllMessages`. Monotonic `m000001`-style ids. Per-workspace append mutex so concurrent `publish()` calls cannot race on id allocation. |
| `lib/event-bus.mjs` | In-process pub/sub. `subscribe`/`unsubscribe`/`publish(cwd, message)`. `publish` appends to the durable log first, then fans out to matching direct subscribers and any `"*"` broadcasters. Fires an OS notification via `notifier.mjs` when a message is `urgent` and addressed to `parent`. |
| `lib/notifier.mjs` | Platform-specific OS notification shim (ADR 0002 §6c). macOS uses `osascript` with AppleScript-escaped title/body; Linux uses `notify-send`; other platforms are silent no-ops. `spawn` (never `exec`), detached, fire-and-forget — a missing command never throws out of `notify()`. |
| `lib/config.mjs` | ADR 0017: the unified two-layer config. `~/.claude/agnz/config.json` (user defaults) + `<cwd>/.claude/agnz/config.json` (optional project overrides, committable), one schema (`{profiles, mappings}`), merged per entry with project winning; every effective value carries its origin. `resolveProfileForModel` is the one model→profile resolution path. Fails loudly (naming ADR 0017) when a legacy `profiles.json` exists without a `config.json`. |
| `lib/data-dir.mjs` | Resolves two data roots. `resolveUserDir()` returns `~/.claude/agnz/` by default (overridable by `$AGNZ_DATA_DIR`). `resolveProjectDir(cwd)` returns `<cwd>/.claude/agnz/`. |
| `lib/proc-lock.mjs` | Cross-process advisory lock (atomic mkdir). Serialises read-modify-write on shared state files (`messages.jsonl`, thread `meta.json`, the index) across the many short-lived CLI/runner processes. |
| `lib/atomic-write.mjs` / `lib/file-lock.mjs` | `atomicWriteFile` (tmp+rename) and `withFileLock` (in-process per-key mutex) — the foundation for safe concurrent writes. |
| `lib/trace.mjs` | Append-only runtime trace. Writes `<thread-id>.trace.jsonl` alongside the transcript. Event types (ADR 0011 §1): `thread_start` (first run only — tools, model, agent, profile + system prompt), `turn_start` (before every LLM call), `llm_call` (latency + finishReason + normalized usage), `tool_call` (name, latency, outcome, `target` — the path-ish argument, powering the last-activity liveness display), `repair` (JSON-arg repair), `pause`, `thread_end` (reason + per-run totals). Field naming is OpenTelemetry-span-mappable. Always fire-and-forget; failures are silent so tracing never crashes the loop. |
| `lib/trace-stats.mjs` | Zero-dep aggregator over `trace.jsonl` (ADR 0011 §2). `aggregateTrace` (pure) folds one thread's events into turns/tokens/latency/tool-outcomes/repair-rate; `aggregateWorkspace` rolls up all traced threads with per-model/per-agent breakdowns. Re-aggregating the file is the authoritative cumulative view across resumes (more accurate than a single run's `thread_end.totals`). Runnable as a CLI (`node lib/trace-stats.mjs [<thread-id>] [--json]`) and surfaced via `inspect.sh stats`. |
| `lib/llm/openai-compatible.mjs` | Native-fetch HTTP client for `/v1/chat/completions`. Works with LM Studio, Ollama, OpenRouter, anything OpenAI-compatible. |
| `lib/tools/registry.mjs` | Tool registry. Wraps tool descriptors, serialises to OpenAI `tools[]` schema. |
| `lib/tools/{LS,Read,Grep}.mjs` | Read-only tools. |
| `lib/tools/{Edit,Write}.mjs` | Mutating tools. |
| `lib/tools/Bash.mjs` | Shell execution via `/bin/sh -c` inside the sandbox cwd. Hard limits: 30 s default timeout and 1 MiB output cap — oversized stdout/stderr triggers SIGKILL and a `content: "Error: ..."` result. |
| `lib/tools/AskUser.mjs` | Special tool: never actually executed; the loop intercepts it in `dispatchToolCall` and pauses with `kind="question"`. |
| `lib/tools/SendMessage.mjs` | The sub-agent's one publishing tool under ADR 0002. Validates the fixed `kind` vocabulary (say/question/answer/handoff/status/error/directive), normalizes `to` as string-or-array, delegates to `event-bus.publish`. |
| `lib/tools/Skill.mjs` | Framework tool. Provides `list` (catalog) and `load` (full body) actions for skills. Searches three locations (project wins on clash): `<pluginRoot>/skills/`, `~/.claude/skills/`, `<cwd>/.claude/skills/`. Always auto-allowed unless explicitly denied. `pluginRoot` arrives via `tool.run` ctx (threaded from `runThread`). |
| `lib/agent-defs.mjs` | ADR 0003 loader. Loads agent files from CC standard paths: `~/.claude/agents/*.md` (user), `<cwd>/.claude/agents/*.md` (project), `<pluginRoot>/agents/*.md` (plugin-bundled, lowest priority). Zero-dep parser supporting both **CC native format** (preferred) and legacy YAML block forms. Exports `parseAgentDefSource`, `validateAgentDef`, `buildToolPolicy`, `loadAgentDef`, `listAgentDefs`. Consumed by the CLI/runner at start time and snapshotted onto the thread meta. |
| `skills/agnz-setup/scripts/companion.mjs` | Slash-command dispatcher for `/agnz:setup`. Handles profile CRUD, mapping, and info sub-commands. |
| `scripts/hooks/{user-prompt-submit,session-start,pre-tool-use}.mjs` + `_lib.mjs` | Claude Code hook scripts for ADR 0002 §6a/6b + ADR 0011 §3 + ADR 0015. `user-prompt-submit`/`session-start` inject unread `to:parent` messages plus a spend-aware workspace summary into Claude's context. Per active thread the summary reads **card-first** from `meta.card` (turns/tokens/ctxTokens/mission `task`, stamped by the loop at every pause/finish), showing `ctx ~Xk` — the resume weight a `send` re-sends — rather than cumulative tokens; `readThreadSpend` folding `trace.jsonl` remains only as the fallback for legacy card-less threads. A `running` thread additionally gets a liveness line tail-read from its trace (`last: Write lib/foo.mjs (12s ago)` — `readLastActivity`, last 8 KiB only). `decideInjection` gates re-injection on a real change: new parent mail **or** a thread-set fingerprint delta (a thread started/stopped), so a pure structural change pushes even without new mail, and idle threads >24h collapse to one aggregate line. The parent's **byte-offset** cursor into `messages.jsonl` and the fingerprint advance via atomic tmp+rename only after stdout drain, so state never runs ahead of what reached Claude. `pre-tool-use` is the ADR 0015 fence: it blocks direct `Read` of thread transcripts/traces and large-context `Grep` (`-A`/`-B`/`-C` > 10) on them, steering the lead toward `show`/`wait`/`inspect.sh`. Self-contained — no imports from `lib/`. Fast no-op when the current project has no agnz workspace. Wired into Claude Code via `hooks/hooks.json` — auto-enabled when the plugin is installed; scoped to the plugin's lifetime. |
| `hooks/hooks.json` | Plugin-level hook manifest. Merges into the user's Claude Code hooks when the plugin is enabled, binding `UserPromptSubmit`, `SessionStart`, and `PreToolUse` (matcher `Read|Grep`) to the `scripts/hooks/*.mjs` scripts with a 5 s timeout. Uses the `{description, hooks: {...}}` wrapper format per plugin-dev guidance. |
| `agents/` | Plugin-bundled agent definitions (dev, researcher, reviewer, general). Loaded at lowest priority — project and user agents shadow them. |
| `skills/agnz-setup/` | Skill for `/agnz:setup` — profiles, model→profile mappings, and `info` sub-command (version, data paths, current state). |
| `skills/agnz-threads/` | Skill for listing and inspecting threads. Reads `.claude/agnz/threads/*.meta.json` and `.jsonl` directly. Includes `scripts/inspect.sh` as a terminal shortcut. |
| `skills/agnz/` | Progressive-disclosure skill for ADR 0003 agent definitions and the `agent_*` lifecycle. `SKILL.md` covers when to delegate + quick define-and-spawn path; `references/defining.md` is the frontmatter field reference; `references/lifecycle.md` is the full CLI lifecycle reference. |
| `lib/skills.mjs` | Shared skill discovery (project + user + plugin roots), used by both `lib/tools/Skill.mjs` and the loop's catalog injection so the two never drift. |
| `.claude-plugin/plugin.json` | Plugin manifest. |

`lib/memory.mjs` **was deleted** as part of the 0.4.0 refactor. There is no project-memory or global-memory `.md` scope any more. If a future design needs persistent cross-run context for a workspace, it goes into `workspace.json` (per ADR 0001) or into board item notes (per ADR 0004), not into a parallel memory store.

Repo layout follows the standard Claude Code plugin layout: `.claude-plugin/plugin.json` at the root, with `lib/`, `bin/`, `scripts/`, `hooks/`, `docs/`, `skills/` as siblings. This repo is a **pure plugin repo** — no marketplace manifest. The marketplace lives elsewhere.

- `tmp/` — gitignored scratch dir for live tests with the sub-agent (created on demand)
- `docs/adr/` — Architecture Decision Records (see bottom of this file)
- `docs/examples/` — runnable example scripts against the library modules; see `dogfood-two-agents.mjs` for an end-to-end ADR 0002 communication smoke test
- `evals/` — ADR 0011 §5 eval harness. `run.mjs` runs `fixtures/<name>/` (prompt + agent def + `expect.mjs` assertion) against named profiles in throwaway workspaces and scores outcome + trace metrics; `score.mjs` is the pure scorecard. Needs a live model — not part of `node --test` (but `score.mjs` is covered by `tests/evals-score.test.mjs`).

## The CLI surface (ADR 0014)

The parent calls `bin/agnz.mjs` via Bash; every verb prints JSON to stdout.

| Verb | Purpose |
|---|---|
| `start <name> ["task"]` | Create a thread (`--agent <def>` or `--inline`). Reuse-aware. |
| `send <name\|id> "msg"` | Send a task; reuses the live thread of that name, else needs an id. |
| `wait <id\|name> [--timeout <s>]` | Poll a detached run until it leaves `running`; prints the outcome (default 300 s timeout; `timeout:true` after — with `lastActivity`, the agent's most recent tool call, as a liveness signal — the runner keeps going). For long runs the skills recommend launching `wait` as a background Bash task so the harness wakes the lead when it exits. |
| `approve <id\|name> allow\|deny [--persist]` | Resolve an approval pause (the pending toolCallId is implicit). |
| `answer <id\|name> "text"` | Resolve an `AskUser` question pause. |
| `interrupt <id\|name> ["directive"]` | Hard-interrupt: abort the current step (incl. a runaway Bash/Grep), stay resumable. |
| `stop <id\|name>` | End + archive a thread (SIGTERM to a live runner); transcript remains, hidden from the list. |
| `remove <id\|name>` / `remove --status stopped\|error` | **Delete** a thread permanently — sweeps every `threads/<id>.*` file + index entry. Live threads must be stopped first. |
| `list` / `show <id\|name>` | Inspect threads; `show` is the lean structural view (status, pending, spend, trace stats — no raw transcript); `list` recovers dead-runner threads. |

All thread-addressing verbs resolve a name to its most recent live thread (same `resolveTarget` path), so `stop <name>` works exactly like `send <name>`.

Always detached — results reach the parent via `messages.jsonl` + the `UserPromptSubmit` hook, or collect sooner with `agnz wait`. There is no `outputSchema`/`structuredContent` any more (that was MCP) — stdout JSON is the contract. Profile management is a slash command (`/agnz:setup`).

## The agent loop in one paragraph

`runThread(ctx)` accepts either a new user message or a resume payload. It loops up to `maxTurns` (default 40): build the message array (system prompt + persisted history), call the LLM, persist the assistant message, dispatch tool calls one by one. A tool call can trigger a pause: either an *approval pause* (tool's policy is `ask`) or a *question pause* (tool name is `ask_user`). Both set thread status to `awaiting_input` with a `pending: {toolCallId, kind, ...}` payload, and return without waiting. When resumed via `agnz approve` or `agnz answer`, the loop injects a tool result for the pending call (the actual tool's output if approved, a denial message if denied, the user's answer if a question) and continues. Every turn starts with a `drainLeftoverToolCalls` pass that handles any unanswered tool calls from the previous assistant turn — important when an assistant message had multiple tool calls and one of them paused.

Note: there is no memory preamble. The thread's context is exactly `system prompt + transcript`. The sub-agent has no persistent cross-thread state today.

## Detached-runner model (ADR 0014)

`start`/`send`/`approve`/`answer` always spawn a detached `lib/runner.mjs` process, return `{status:"started"}`, and exit. The runner advances the loop one segment, writes its result to `messages.jsonl`, and exits. The parent picks it up via the `UserPromptSubmit` hook at the next prompt, or collects sooner with `agnz wait <id>` — a watcher that polls the thread, not a second run mode (ADR 0015).

- Non-blocking status peek: read `<cwd>/.claude/agnz/threads/<thread_id>.meta.json`, or `agnz show <id>`.
- No standing process: nothing runs between runs (state is files). There is no `run-tracker`; the runner records its pid on the thread meta for `stop`/`interrupt`.

**Concurrency is real OS processes**, not event-loop coroutines — each run is its own `node` process, so multiple agents run in genuine parallel (and a slow one can't head-of-line-block another). The trade-off: shared state files are touched by many processes, which is why writes go through `proc-lock.mjs` (cross-process mkdir lock) + atomic tmp+rename.

## Sandbox + permissions

`createSandbox({root, policy})` returns an object with:
- `resolvePath(p)` — turns relative path into absolute, refuses to escape root, resolves symlinks against root once at construction time
- `checkPermission(toolName)` — returns `"allow"`, `"ask"`, or `"deny"`
- `recordDecision(toolName, decision)` — used by `agnz approve` with `persist=true` to upgrade a non-Bash tool's policy for the rest of the thread (session-scoped, in-memory only)
- `getRoot()`, `getPolicy()`

**Policy model — single source of truth: the agent def frontmatter.**

| Frontmatter | Result |
|---|---|
| `tools: [Read, Grep]` | `allow` — runs without asking |
| `disallowedTools: [Edit]` | `deny` — always blocked |
| not mentioned | `ask` — approval required |
| Skill (any config) | `allow` — always auto-allowed unless explicitly denied |

No profile `defaultPolicy`, no workspace lists. `buildToolPolicy(agentDef, availableTools)` in `agent-defs.mjs` is the only place this is computed, at thread-creation time.

**Bash is special** — an additional layer of session-scoped command tracking sits on top of the tool-level policy. When Bash is `ask` and a command has been previously approved in this thread, it runs silently. Commands are stored in `thread.meta.json` → `sessionCommands.{sessionAllow,sessionDeny}`. Use `persist=true` on `agnz approve` to save the command to the session list; without it the approval is one-time only.

Tool names are PascalCase, matching Claude Code's built-in tool naming so agent definition files can be shared between CC and agnz without modification.

`Bash` runs `/bin/sh -c <command>` inside the sandbox cwd with a 30 s default timeout and a 1 MiB cap on stdout/stderr (oversized output SIGKILLs the child).

## Persistence layout

There are now **two** independent roots.

### User-wide (`resolveUserDir()`)

Default `~/.claude/agnz/`. Overridable by `$AGNZ_DATA_DIR`.

```
~/.claude/agnz/
└── config.json              ← user-layer config: {profiles, mappings}
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

`workspace.json` is pure workspace **state** (ADR 0017): `schemaVersion: 2`, timestamps, and `parent: {cursor, offset, threadFingerprint}` — the parent's delivery position, written by the CC hooks after stdout drain (there is no `cursors/` directory any more). `name`/`cwd` were dropped (derivable from the file's location; a stored cwd was observed lying after a project move). Config lives in `config.json` (either layer). Per thread there are up to four files: `<id>.meta.json`, `<id>.jsonl` (transcript), `<id>.trace.jsonl`, and `<id>.system.txt` (the frozen prompt prefix, write-once — extracted from the meta where it was ~75 % of every rewrite). `agnz remove` sweeps all of them by the `<id>.` prefix. ADR 0004 will grow board fields on `workspace.json`. Agent definitions live in CC's standard locations (`~/.claude/agents/` and `<cwd>/.claude/agents/`), not under `agnz/`.

The old `memory/` directory is gone. The old `threads/` directory under the user-wide root is gone.

## Plugin development workflow

### Branching

Day-to-day work (bugfixes, refactoring, new features) lives on the `dev` branch. `main` is release-only — merge `dev` → `main` at release time, then bump the version and push. Never commit directly to `main` except for hotfixes that need to ship immediately.

### Versioning rule

**Only bump `version` when pushing / publishing a release.** Day-to-day feature work on a branch keeps the current version string. A release bundles several branches' worth of work and bumps once at push time, either on the release commit or immediately before `git push`. This keeps semantic versioning meaningful instead of burning a minor number per refactor.

Semver guidance: patch (`0.x.Y`) for bug fixes, minor (`0.X.0`) for new features or breaking MCP surface changes (removed/renamed tools, changed defaults).

The single file that moves on a release bump:

- `.claude-plugin/plugin.json` (the `version` field)

The bump commit goes on the feature/integration branch and is merged to `main` with the release — not as a separate commit directly on a shared branch.

### Iterating locally against the installed plugin

CC caches each installed plugin version under `~/.claude/plugins/cache/<marketplace>/<plugin>/<VERSION>/`. Since we no longer bump for every change, reinstall via one of:

1. `/plugin marketplace update agnz && /plugin install agnz@agnz && /reload-plugins` — the marketplace updater overwrites the cached version directory in place; the hooks and skills pick up the new source after a reload.
2. There is no standing server any more: `bin/agnz.mjs` is spawned fresh on every call, so code changes take effect immediately for new runs. Only the *hooks* live in CC's process and need the reload above. For fast iteration, symlink the cache dir to your working tree: `ln -s <repo> ~/.claude/plugins/cache/<marketplace>/agnz`.

`/plugin uninstall agnz` is **broken** in current CC for local marketplace plugins (it actually re-enables instead of removing). Marketplace-update + reinstall is the working path.

Verify by running `agnz list` (and the `/agnz:threads` / `/agnz:setup` skills should be available).

## Profile setup (LM Studio example)

LM Studio default endpoint is `http://localhost:1234/v1`. After installing the plugin, run `/agnz:setup add` (interactive) or directly:
```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/agnz-setup/scripts/companion.mjs setup add lmstudio-devstral http://localhost:1234/v1 mistralai/devstral-small-2-2512
```
Profile resolution at thread start (ADR 0017): merged config `mappings[agentDef.model]` → `mappings["_default"]` → the identifier as a profile name — all from the two-layer `config.json` (project overrides user, per entry). Configure via `/agnz:setup`; every write command takes `--project` to target the project override layer, and `info` renders the effective merged view with per-value origins.

## Useful commands during development

```bash
# Run an agent against the configured profile (needs a live model), then collect its outcome
node bin/agnz.mjs start probe "List the .mjs files under lib/ and count them." \
  --agent researcher --cwd "$PWD"
node bin/agnz.mjs wait probe --cwd "$PWD"

# Drive / inspect threads
node bin/agnz.mjs list
node bin/agnz.mjs show <thread-id>

# Run the test suite (loop runs against an injectable fake LLM — no model needed)
node --test tests/*.test.mjs
```

## Conventions

- **Native Node only.** No npm dependencies in the plugin.
- **Comments explain *why*, not what.** The code already says what it does.
- **JSONL for streams, JSON for snapshots.** Thread transcripts append-only, thread meta rewritten in place.
- **Two data roots, two lifetimes.** User-wide under `resolveUserDir()` is for cross-project personal state (profiles). Per-project under `resolveProjectDir(cwd)` is for work-in-progress state that belongs with the code. Don't cross the streams.
- **Sub-agent prompts live in `lib/prompts.mjs`** (`INSTRUCTIONS`, `SANDBOX_FRAMING`, `AVAILABLE_TOOLS`, `DENIED_TOOLS`, `SKILLS_HEADER`).
- **Edit-tool gotcha: em-dash in comments.** Several files (notably `loop.mjs`) use `—` (U+2014) in inline comments. The Edit tool's `old_string` match silently fails on these. Workaround: use a shorter `old_string` that avoids the em-dash line, or diagnose with `hexdump -C`.

## Design-in-progress: the ADRs

The ADRs under [`docs/adr/`](./docs/adr/) document the architecture. Read them before making non-trivial changes — they are the authoritative source of truth. Status as of this file:

- **[ADR 0001 — Workspace-first architecture.](./docs/adr/0001-workspace-first-architecture.md)** Workspace as a per-project directory; MCP shrinks to process lifecycle; parent reads state from files. **Implemented in v0.4.0.** `data-dir` user/project split, `workspace-store.mjs`, `thread-index.mjs`, `threads.mjs` rewrite, `memory.mjs` removal, MCP surface down to 6 tools. No formal schema beyond the skeleton yet.
- **[ADR 0002 — Communication: mailboxes and events.](./docs/adr/0002-communication-mailbox-and-events.md)** Event bus + per-recipient mailboxes + `messages.jsonl` + `UserPromptSubmit`/`SessionStart` hooks + OS notifications. **Implemented in v0.4.0.** New modules: `lib/messages-log.mjs` (durable log with monotonic ids and a per-workspace append mutex), `lib/event-bus.mjs` (pub/sub with append-then-fanout), `lib/notifier.mjs` (macOS/Linux OS notification shim for urgent mail addressed to parent). `lib/tools/send_message.mjs` is the sub-agent's one publishing tool — reading is automatic, the loop drains the mailbox for `agentName` at the top of every turn and injects new mail as a synthetic user message. Hook scripts live under `scripts/hooks/` (`_lib.mjs`, `user-prompt-submit.mjs`, `session-start.mjs`) and are wired into Claude Code via `hooks/hooks.json` — **auto-enabled** when the plugin is installed, scoped to the plugin's lifetime (disable the plugin and the hooks go away). Each hook is a fast no-op when the current project has no agnz workspace. The cursor advance uses an atomic tmp+rename after stdout drain so messages can't be silently marked delivered without reaching Claude.
- **[ADR 0003 — Agent definitions.](./docs/adr/0003-agent-definitions.md)** `.md` files with YAML frontmatter loaded from three locations (project > user > plugin-bundled). Layers a role, system prompt, and tool policy on top of a profile. Referenced by name at `agnz start` time. **Implemented.** `lib/agent-defs.mjs` is the zero-dep loader; supports CC frontmatter fields. the CLI/runner resolves the def, builds policy via `buildToolPolicy` (ask-everything default; `tools:`/`disallowedTools:` override; `Skill` auto-allow when `skills:` set), snapshots onto `thread.agentDef`. Agent body goes into the system prompt (not as a user message — doing so breaks strict-alternation models like Mistral). Plugin-bundled defaults live in `agents/`. Skills under `skills/agents/` document the user-facing surface.
- **[ADR 0004 — Board: mini-scrum for shared work.](./docs/adr/0004-board-mini-scrum.md)** Kanban-style board on `workspace.json` with columns, owners, dependencies, a review gate, and a `mode: planning|executing` flag. Replaces any flat-todo concept. `board_add`/`board_move`/`board_note`/`board_assign` as sub-agent tools. **Not implemented** — `workspace.json` today has no `items`, no `mode`, no `reviewRequired`.
- **[ADR 0005 — Skills for agents.](./docs/adr/0005-skills-for-agents.md)** **Superseded by ADR 0006.** The `Skill` tool (implemented as `lib/tools/Skill.mjs`, always `allow`) provides `list`/`load` actions for skills across three locations: plugin root → `~/.claude/skills/` → `<cwd>/.claude/skills/` (project wins). Agent defs support a `skills:` sequence allowlist; `lib/loop.mjs` always injects the skill catalog into the system prompt (`agentDef.skills` acts as a filter, not a feature switch). `pluginRoot` is threaded through `runThread` ctx.

- **[ADR 0006 — MCP servers for agents.](./docs/adr/0006-mcp-for-agents.md)** Sub-agents get access to external MCP tool surfaces. **Proposed (roadmap).**
- **[ADR 0007 — Parent context.](./docs/adr/0007-parent-context.md)** How Claude sees and uses the workspace — `UserPromptSubmit` hook injects a structured workspace summary (agents, thread statuses, unread messages) so Claude knows what's running without manual file reads. **Proposed (roadmap).**
- **[ADR 0008 — Brain system.](./docs/adr/0008-brain-system.md)** Three-tier memory for agents. **Proposed (roadmap).**
- **[ADR 0009 — Tool configuration.](./docs/adr/0009-tool-configuration.md)** Agent definitions gain `preset:` (`read-only` / `standard` / `full`) and `tool_config:` keys for per-tool configuration (e.g. Bash timeout, allowedCommands). **Partially superseded.** The `allowedCommands` workspace-store approach (permanent per-agent Bash allow/deny lists in `workspace.json`) was abandoned in favour of session-only tracking in `thread.sessionCommands`. The `preset:` and `tool_config:` keys are still valid roadmap items but not yet implemented.
- **[ADR 0010 — Workspace file manager.](./docs/adr/0010-workspace-file-manager.md)** Open/close files as context state. **Proposed / Deferred.**
- **[ADR 0011 — Observability and evaluation.](./docs/adr/0011-observability-and-evaluation.md)** Completes the runtime trace schema (`llm_call`/`tool_call`/`repair`/`thread_end` with latency + outcome), a zero-dep stats aggregator (`trace-stats.mjs`) surfaced through `inspect.sh` and the ADR 0007 parent hook, `node:test` loop/sandbox/mailbox coverage via a fake-LLM double, and an `evals/` fixture+scorecard harness for measuring local-model quality per profile. Trace schema is OpenTelemetry-mappable so an opt-in exporter can be added later without touching the loop. **Implemented (§1–§5):** full trace schema + injectable LLM client (§1), `trace-stats.mjs` + `inspect.sh stats` (§2), spend-aware workspace summary in the hooks (§3), fake-LLM loop/sandbox/mailbox test coverage (§4), and the `evals/` fixture+scorecard harness (§5) — all with `node:test` coverage. §6 (OTel exporter) is deliberately schema-only.

- **[ADR 0012 — Context management.](./docs/adr/0012-context-management.md)** The sub-agent loop has no context management: `buildMessages` rebuilds and re-sends the full prompt every turn, and parts *grow* (visited-dir CLAUDE.md in the system prompt → `lib/loop.mjs:682`; unbounded transcript with verbatim tool results up to 512 KiB/1 MiB). This defeats prefix caching and makes server memory climb monotonically even on mechanical tasks. **Phase 1 implemented** (`renderSystemPrompt` snapshot on first run → `thread.systemPromptSnapshot`, reused every turn; visited-dir CLAUDE.md injected once into history via `pendingDirMds` + `drainTopOfTurnContext`; covered by `tests/context-prefix.test.mjs`). **Phase 2 (proposed):** compact old/large tool results on re-send (full text stays on disk). **Phase 3 (proposed):** token-budget sliding window. Measurable via the ADR 0011 trace (`llm_call.usage.prompt` per turn).

- **[ADR 0013 — Tool workflow discipline.](./docs/adr/0013-tool-workflow-discipline.md)** The behavioural counterpart to ADR 0012: keep context lean by guiding *how* the agent uses tools. **Grep before Read** (efficiency — locate then read a slice, soft guidance) and **Read before Write/Edit of an existing file** (correctness — never clobber unread content, near-absolute, candidate for hard enforcement). **Implemented** as harness logic, not just prompt text: a reactive interceptor (`checkWorkflowDiscipline` in `lib/loop.mjs`, called early in `dispatchToolCall`) backed by a per-thread knowledge state (`knownFiles` on thread meta, updated after every successful Read/Write/Edit). On a violation it blocks the tool and injects a `Workflow:` corrective prompt; the block is traced as `tool_call outcome:"blocked"`. Read→Write is a hard block on existing unread files; Grep→Read is a size-gated redirect (`LARGE_READ_BYTES`). Cache-safe (only smaller appends, never mutates earlier messages). Covered by `tests/workflow-discipline.test.mjs`. (Complemented by the anchor-based `Edit` tool, which independently requires having read the bytes to be changed.)

- **[ADR 0014 — CLI replaces the MCP server.](./docs/adr/0014-cli-replaces-mcp.md)** The parent drives agnz through the `bin/agnz.mjs` CLI (verbs, Bash, JSON on stdout) instead of an MCP stdio server. Each run is a detached `lib/runner.mjs` process; results still reach the parent via `messages.jsonl` + the hook. **Implemented (0.13.0):** removed `mcp/server.mjs`/`mcp/jsonrpc.mjs`/`run-tracker.mjs`/`.mcp.json`; added `bin/agnz.mjs`, `lib/runner.mjs`, `lib/orchestrate.mjs`; foundation hardened for the multi-process model (`lib/proc-lock.mjs` cross-process mkdir locks + atomic tmp+rename on `messages.jsonl`/meta/index); plus reuse-by-name, rolling thread summaries (ADR 0007), and opportunistic stale-run recovery. **Parent invocation:** CC adds an enabled plugin's `bin/` to the parent shell's `PATH`, so the parent runs `agnz <verb>` by bare name from any cwd (no `$CLAUDE_PLUGIN_ROOT` needed); `bin/agnz` is a thin sh wrapper over `bin/agnz.mjs`.
- **[ADR 0015 — Lead-side context discipline.](./docs/adr/0015-lead-context-discipline.md)** The lead-side counterpart to ADR 0013: `--wait` and direct transcript reads both undermine the small-context goal agnz exists for. **Implemented.** `--wait` removed from `start`/`send`/`approve`/`answer` in favour of the `agnz wait` watcher verb; `agnz show` is now the lean structural view (meta minus `systemPromptSnapshot`/`agentDef` body, capped message excerpts, folded-in trace stats); the "ask, don't read" escalation ladder is documented across the skills; a `PreToolUse` hook (`scripts/hooks/pre-tool-use.mjs`) blocks direct `Read` of thread transcripts/traces (`Grep` and `inspect.sh` stay open). The `messages.jsonl` schema-sample mode floated in the ADR did not ship.
- **[ADR 0016 — Harness calls: the local model as infrastructure service.](./docs/adr/0016-harness-calls.md)** Use the local LLM for small tool-less calls that improve agnz's own infrastructure (e.g. a real rolling-summary call instead of the current heuristic), not just for agent work. **Proposed — deferred pending dogfooding** of the cheaper mechanical resume-card alternative, and pending validation of queueing latency against a serialized local inference server.
- **[ADR 0017 — Config and state consolidation.](./docs/adr/0017-config-and-state-consolidation.md)** One config schema in two layers (`config.json`, user defaults + committable project overrides, project wins per entry); `workspace.json` reduced to pure state carrying the parent's delivery position (`cursors/` gone); the user-wide thread index deleted (id→cwd resolution is cwd-scoped, `--cwd` for the rare cross-project call); `systemPromptSnapshot` extracted to a write-once `<id>.system.txt`. **Implemented (0.18.0, breaking — no migration):** old layouts fail loudly with a pointer to `/agnz:setup`; the hooks read legacy cursors once as a fallback so no delivered mail is re-injected.

When implementing any ADR, follow it as the spec and keep deviations visible (either an amendment in the ADR or a note in the commit message).

## Known gaps / TODO

- **No streaming.** A detached run returns one outcome at a time. Intermediate progress is not observable to the parent. ADR 0002 changes this picture for agent-to-parent communication via `messages.jsonl`.
- **Test coverage** (ADR 0011 §4). `node:test` now covers: sandbox path/symlink-escape + permissions (`tests/sandbox.test.mjs`), loop pause/resume (approval allow/deny, question answer, leftover-drain) + error propagation (`tests/loop-resume.test.mjs`), mailbox drain + cursor advance (`tests/mailbox.test.mjs`), the trace schema (`tests/loop-trace.test.mjs`), trace-stats (`tests/trace-stats.test.mjs`), plus the existing workspace-store/thread-index/data-dir plumbing. Loop tests inject a fake LLM via `ctx.chat` and the shared `tests/_fake-llm.mjs` harness. Run `node --test tests/*.test.mjs` — the full suite is green (the former known-red `items: []` expectation in `tests/workspace-store.test.mjs` no longer fails).
- **Bash sessionCommands are session-scoped only.** Approved commands are not persisted across separate runs. A fresh session re-asks for every command. ADR 0009's `allowedCommands` workspace lists were the planned fix but were removed for simplicity — revisit if this becomes painful.
- **Multi-session cursor race.** The parent message cursor (`workspace.json` → `parent`) is per-workspace, not per-session. With two Claude Code sessions open on the same project, whichever session's hook fires first advances the cursor, and the other session never sees those messages. Accepted limitation — per-session cursors were deliberately not built (they'd leave cursor corpses behind for every dead session, and the multi-session-on-one-project case is rare enough that the effort isn't justified yet).
- **License.** MIT is declared in `plugin.json` and README but no `LICENSE` file exists in the repo root yet.
