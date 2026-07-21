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
→ {"thread_id":"abc…","name":"researcher-1","agent":"researcher","status":"started"}
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
→ {"thread_id":"abc…","status":"final","content":"…"}
```

Default timeout is 300 s. On timeout, prints the current state with
`timeout:true` and exits `0` — the watching call gave up, the detached runner
underneath keeps going:

```bash
agnz wait researcher-1 --timeout 5
→ {"thread_id":"abc…","status":"running","timeout":true}
```

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

### `list [--status <s>] [--all]`

List threads in this workspace (`--all` = every workspace; `--status idle`
filters). Each entry carries `name`, `status`, a rolling `summary`, and
`updatedAt`. Opportunistically marks threads whose runner has died as `error`.

```bash
agnz list
→ [{"thread_id":"abc…","name":"researcher-1","agent":"researcher",
    "status":"idle","summary":"Summarised request logging; auth uses JWT","updatedAt":…}]
```

### `show <id>`

The lean structural view of a thread (ADR 0015) — the default first-reach
inspection tool. Returns `meta.json`'s content minus its two heavy embedded
fields (`systemPromptSnapshot`, the agent def's full body), plus status,
pending, error, summary, cwd, and spend. Each recent-message excerpt is
capped (~500 chars) with an elision marker reporting the original size, so a
routine status check can never forward a full tool result. It also folds in
the thread's aggregated trace stats — turns, tokens, latency, tool outcomes,
repair rate, the same fold `lib/trace-stats.mjs` computes — so one call
answers "what is this thread, what did it do, how heavy is it."

Deliberately **not** included: the raw transcript. For that, ask the thread
(`agnz send <name> "…"`) or use the `agnz-threads` skill's `inspect.sh` for a
capped tail — direct `Read` of the transcript/trace `.jsonl` files is blocked
by a `PreToolUse` hook (see
[ADR 0015](./adr/0015-lead-context-discipline.md)).

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
