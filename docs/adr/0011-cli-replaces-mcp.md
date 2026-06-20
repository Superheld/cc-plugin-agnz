# ADR 0011: CLI replaces the MCP server

- **Status:** Accepted (implemented)
- **Date:** 2026-06-20
- **Supersedes:** the MCP stdio server surface (`mcp/server.mjs`, `mcp/jsonrpc.mjs`) and the in-memory `run-tracker.mjs`.

## Context

agnz exposed its lifecycle to the parent Claude session through an MCP stdio
server: five tools (`agent_start`, `agent_stop`, `thread_send`, `thread_approve`,
`thread_answer`). But the **return** channel was already file/hook-based — results
reach the parent via `SendMessage(to:"parent")` → `messages.jsonl` → the
`UserPromptSubmit` hook. MCP was carrying only the *inbound* commands.

That made the MCP server ~860 lines of machinery (server + hand-rolled JSON-RPC +
run-tracker) for something a CLI does more simply, and more composably: a CLI is
usable by the parent (via Bash), by a human in a terminal, by other sub-agents
(agent-to-agent via Bash), and by cron — all the same surface.

## Decision

**A CLI (`bin/agnz.mjs`) replaces the MCP server.** The parent invokes it via Bash;
every verb prints a JSON object/array to stdout.

Verbs: `start`, `send`, `approve`, `answer`, `stop`, `interrupt`, `list`, `show`.

### Where the loop runs — detached runner (model "c")

There is no standing server process. Each `start`/`send`/`approve`/`answer` that
needs the loop to move forward spawns a **detached, unref'd runner**
(`lib/runner.mjs`) that runs `runThread` one segment (until the next pause or
finish), then exits. State lives in files; results reach the parent via the
unchanged hook path. `--wait` runs the segment inline instead for short tasks.

Shared orchestration (profile resolution, sandbox construction, plugin-root) lives
in `lib/orchestrate.mjs`, used by both the runner and the inline path.

### Signals

The runner records its pid on the thread meta. `stop` sends `SIGTERM` (terminal);
`interrupt` sends `SIGUSR1` (abort the current segment but leave the thread
resumable, optionally queueing a directive). The abort signal is threaded into
`tool.run` so a runaway `Bash`/`Grep` is actually killed (Bash runs detached and
its whole process group is reaped).

### Reuse-by-name

`send <name>` resolves to the most recent live thread of that name (idle/stopped/
running/awaiting — never errored) and resumes it, instead of spawning a new one.
`start` always creates fresh.

## Consequences

- **Concurrency is now real OS processes**, not Node event-loop coroutines. More
  robust (no head-of-line blocking on one slow fetch), but it means shared state
  files are touched by multiple processes — see locking below.
- **Cross-process locking** became mandatory. `lib/proc-lock.mjs` (atomic mkdir
  lock) serialises read-modify-write on `messages.jsonl`, thread `meta.json`, and
  the thread index across processes. The in-process promise-chain mutexes remain as
  the efficient single-process layer.
- **No standing server means no boot-time stale-run recovery.** The CLI recovers
  opportunistically: `list`/`show` mark a `running` thread whose runner pid is dead
  as `error`.
- **Discoverability moves to the skill/docs.** The parent learns the verbs from
  `skills/agnz/SKILL.md`; there is no MCP tool schema. The CLI is located at
  `$CLAUDE_PLUGIN_ROOT/bin/agnz.mjs`.
- `.mcp.json` is removed; `plugin.json` no longer advertises an MCP server.

## Open

- **CLI location.** Whether `$CLAUDE_PLUGIN_ROOT` is reliably set in the parent's
  Bash environment needs verification; if not, the plugin needs another way to
  surface the binary path.
- The reference docs under `skills/agnz/references/` still describe the old MCP
  tool names in places — the SKILL.md verbs are authoritative until they are
  rewritten.
