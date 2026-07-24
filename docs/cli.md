# agnz CLI reference

The parent (and you, in a terminal) drive agnz through `bin/agnz.mjs`. There is
no MCP server (see [ADR 0014](./adr/0014-cli-replaces-mcp.md)).

```bash
agnz <verb> [positional…] [--flags]
```

Every verb prints a JSON object (or array) to **stdout**. Errors print
`{"error":"…"}` and exit non-zero. Output is the contract — parse it.

## Global flags

| Flag | Applies to | Meaning |
|---|---|---|
| `--cwd <path>` | all | Workspace / sandbox root. Defaults to `$AGNZ_CWD` or the current dir. |

There is no `--wait` flag any more — every run is detached (ADR 0015). Passing
`--wait` to `start`/`send`/`approve`/`answer` errors, pointing at `agnz wait`
below.

## Verbs

### `start <name> ["task"] (--agent <def> | --inline "<frontmatter>")`

Create a thread named `<name>` (the routing address). Provide a role via
`--agent <def-name>` (resolved from `<cwd>/.claude/agents/`, `~/.claude/agents/`,
then the bundled `agents/`) or `--inline "<frontmatter md>"` for an ad-hoc role.
Optional `--description "…"`. Without a `"task"`, the thread starts `idle`.

```bash
agnz start researcher-1 "Summarise how request logging works." --agent researcher
→ {"thread_id":"abc…","name":"researcher-1","role":"researcher","status":"started"}
```

### `send <name|id> "message"`

Send a task or follow-up. A bare **name reuses** the most recent live thread of
that name (resume — keeps its context); pass a thread-id to target one exactly.
Idle/stopped → starts a run; running/awaiting → the message is queued to the
mailbox and delivered at the next turn boundary. Error threads are refused.

```bash
agnz send researcher-1 "Now also check the test files."
→ {"thread_id":"abc…","status":"started"}   # or "queued"
```

### `wait <id|name> [--timeout <s>]`

Poll a detached run until it leaves `running`, then print the outcome — a
*watcher*, not a worker. Accepts a thread id or a name (resolved the same way
`send` resolves names).

```bash
agnz wait researcher-1 --timeout 120
→ {"thread_id":"abc…","status":"idle","content":"…"}
```

`wait` prints the thread's persisted status. The terminal statuses you can
collect are: `idle` (the run finished — carries `content`, the distilled final
answer), `awaiting_input` (paused — carries `pending`), `error` (crashed —
carries `error`), and `stopped` (archived). A finished run is `idle`, not a
distinct "final" status.

Default timeout is 300 s. On timeout, prints the current state with
`timeout:true` and exits `0` — the watching call gave up, the detached runner
underneath keeps going:

```bash
agnz wait researcher-1 --timeout 5
→ {"thread_id":"abc…","status":"running","timeout":true,
   "activity":{"phase":"generating","since":"84s","last_action":"Write lib/foo.mjs · 2m"}}
```

The `activity` triple is the liveness signal: `phase` labels what the thread is
doing right now (`generating` = an LLM call is in flight — on slow local
inference a stale `last_action` during a long generation is normal, not a
hang), `since` is how long the current step has run, `last_action` is the last
completed tool call.

Call `wait` again, or let the `UserPromptSubmit` hook deliver the result
passively at your next prompt. Calling `wait` on a thread that's already left
`running` (idle, `awaiting_input`, stopped, error) returns its outcome
immediately — a **collect** call for a run you already know finished.

This is the replacement for `--wait`: start several runs detached, do other
work, then collect each with `wait` — parallel instead of serial.

### `approve <id> allow|deny [--persist]`

Resolve an approval pause. The pending `toolCallId` is implicit (the thread has
one pending call). `--persist` upgrades that tool to `allow` for the rest of the
run (Bash is tracked per-command).

```bash
agnz approve abc allow --persist
```

### `answer <id> "answer text"`

Resolve an `AskUser` question pause.

```bash
agnz answer abc "Use the US English spelling."
```

### `interrupt <id> ["directive"]`

Hard-interrupt a working/runaway agent: abort the current step (kills a runaway
`Bash`/`Grep` mid-execution too), leave the thread resumable. An optional
directive is queued and drains on the next run.

```bash
agnz interrupt abc "Stop — use the existing helper instead of a new one."
→ {"thread_id":"abc","status":"interrupted","signalled":true,"directive_queued":true}
```

### `stop <id>`

End a thread (SIGTERM to its runner; the transcript is kept).

```bash
agnz stop abc → {"thread_id":"abc","status":"stopped"}
```

### `show` (no target) `[--status <s>]`

List threads in this workspace (`--status idle` filters; `list` survives as an
undocumented alias). Each entry carries `name`, `role`, `status`, the judged
`verdict` (plus `evidence`/`action` when the verdict warrants it — e.g. a hung
LLM call with the `interrupt` command attached), a rolling `summary`,
`updatedAt`, and for running threads the `activity` liveness triple.
Opportunistically marks threads whose runner has died as `error`.

```bash
agnz show
→ [{"thread_id":"abc…","name":"researcher-1","role":"researcher","status":"idle",
    "verdict":"done","summary":"Summarised request logging; auth uses JWT","updatedAt":…}]
```

### `show <id>`

The lean structural view of a thread (ADR 0015) — the default first-reach
inspection tool. Returns the thread's structural state — status, `role` (the
def name; the full agent def is deliberately absent), pending, error, summary,
cwd, spend — plus `filesTouched`, the per-path fold of the thread's successful
Write/Edit calls ("lib/foo.mjs (1 write, 3 edits)"): the pointer that tells a
reviewing lead where to aim `git diff`. `recent` carries the last agent-side
turns only (the lead's own user-role directives are filtered out — they were
observed echoing kilobytes back), each excerpt capped (~500 chars) with an
elision marker reporting the original size, so a routine status check can
never forward a full tool result. It also folds in the thread's aggregated
trace stats — turns, tokens, latency, tool outcomes, repair rate, the same
fold `lib/trace-stats.mjs` computes — so one call answers "what is this
thread, what did it do, how heavy is it."

Deliberately **not** included: the raw transcript. For that, ask the thread
(`agnz send <name> "…"`) — direct `Read` of the transcript/trace `.jsonl` files is blocked
by a `PreToolUse` hook (see
[ADR 0015](./adr/0015-lead-context-discipline.md)).

### `mailbox [--from x] [--to x] [--kind k] [--limit n]`

Read-only peek into the workspace message log (`messages.jsonl`) as an
interface instead of raw file parsing. Parent mail arrives via the hook; this
verb covers what the hook does **not** deliver — agent-to-agent traffic in a
team, or re-reading already-consumed mail. Never touches the parent cursor, so
peeking cannot mark anything as delivered. Long texts are capped like every
lean surface; `--to` matches array recipients too. Default `--limit 20`
(newest kept), with an honest `total` alongside.

```bash
agnz mailbox --from dev --kind handoff
→ {"total":3,"shown":3,"messages":[{"id":"m000041","at":"…","from":"dev",
    "to":"reviewer","kind":"handoff","text":"…"}]}
```

## How results reach the parent

Every run is detached (ADR 0015). Results are delivered via
`SendMessage(to:"parent")` → `messages.jsonl` → the `UserPromptSubmit` hook,
which injects unread parent mail into the parent's next prompt (an OS
notification fires for urgent mail). There is no push — the parent learns of a
finished agent at its next turn, unless it explicitly collects sooner with
`agnz wait <id>`. `agnz show <id>` peeks at the current state any time
without blocking.

## Exit codes

`0` on success, non-zero on error (with a `{"error":"…"}` JSON line on stdout).
