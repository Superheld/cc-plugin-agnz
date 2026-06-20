# agnz CLI reference

The parent (and you, in a terminal) drive agnz through `bin/agnz.mjs`. There is
no MCP server (see [ADR 0014](./adr/0014-cli-replaces-mcp.md)).

```bash
node "$CLAUDE_PLUGIN_ROOT/bin/agnz.mjs" <verb> [positional…] [--flags]
```

Every verb prints a JSON object (or array) to **stdout**. Errors print
`{"error":"…"}` and exit non-zero. Output is the contract — parse it.

## Global flags

| Flag | Applies to | Meaning |
|---|---|---|
| `--cwd <path>` | all | Workspace / sandbox root. Defaults to `$AGNZ_CWD` or the current dir. |
| `--wait` | start, send, approve, answer | Run the segment **inline** and return the outcome, instead of spawning a detached runner. |

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

Full thread state (status, pending, error, summary, cwd) plus the last few
transcript messages.

## How results reach the parent

Detached runs (the default) deliver their result via
`SendMessage(to:"parent")` → `messages.jsonl` → the `UserPromptSubmit` hook,
which injects unread parent mail into the parent's next prompt (an OS
notification fires for urgent mail). There is no push — the parent learns of a
finished agent at its next turn. Use `--wait` to get the outcome synchronously
in the same call, or `agnz show <id>` to peek any time.

## Exit codes

`0` on success, non-zero on error (with a `{"error":"…"}` JSON line on stdout).
