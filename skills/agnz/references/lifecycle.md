# Sub-agent lifecycle

Companion to [SKILL.md](SKILL.md). The full conversation flow between Parent Claude and an agnz sub-agent, driven by the **`agnz` CLI** (there is no MCP server — see [ADR 0014](../../../docs/adr/0014-cli-replaces-mcp.md)).

Invoke every verb via Bash; each prints JSON to stdout:

```bash
agnz <verb> [args...]
```

## The verbs

### `start`

Create a thread locked to a working directory.

```bash
agnz start researcher-1 "Find all call sites of parseConfig and summarize." \
  --agent researcher --cwd /abs/path
→ {"thread_id":"abc…","name":"researcher-1","agent":"researcher","status":"started"}
```

`--inline "<frontmatter>"` defines an ad-hoc role instead of `--agent`. Without a task, the thread starts `idle`. The thread is persisted at `<cwd>/.claude/agnz/threads/<id>.meta.json`, recoverable across runs.

### `send`

Send a task or follow-up. **Reuses** the most recent live thread of that name (resume), so a follow-up keeps its context; pass a thread-id to target one exactly.

```bash
agnz send researcher-1 "Now also check the test files."
→ {"thread_id":"abc…","status":"started"}   # or "queued" if the thread is mid-run
```

### `wait`

Watch a detached run and collect its outcome — a *watcher*, not a worker: it polls the thread's meta with backoff and returns once the thread leaves `running`.

```bash
agnz wait researcher-1 --timeout 120
→ {"thread_id":"abc…","status":"idle","content":"…"}
```

Default timeout is 300s. On timeout it prints `{..., timeout:true}` plus a `lastActivity` field — the agent's most recent tool call (`{name, target, agoMs}`) — and exits 0. Read `lastActivity` as a liveness check: an `agoMs` of a few seconds means "still working, keep waiting"; minutes of silence mean "look closer" (`agnz show`, or `interrupt` if it ran amok). The underlying detached runner is untouched either way; call `wait` again, or just let the `UserPromptSubmit` hook deliver the result at your next prompt. Calling `wait` on a thread that's already left `running` (idle, awaiting_input, stopped, error) returns its outcome immediately — a **collect** call, useful right after you already know the run finished.

This is what replaces `--wait`: start several agents detached, do your own work, then collect each with `wait` — parallel instead of serial.

```bash
agnz start auth    "…" --agent researcher
agnz start billing "…" --agent researcher
# … do other work …
agnz wait auth
agnz wait billing
```

**Long runs: put `wait` in the background.** If your harness's Bash tool supports background execution (Claude Code: `run_in_background`), run `agnz wait <id> --timeout 600` as a background task and go on with other work — the harness notifies you the moment the wait exits, i.e. when the agent finishes, pauses, or the timeout fires. That turns "agent finished" into an event you're woken up for instead of a state you have to remember to poll, and it costs nothing while you're busy elsewhere. On a `timeout:true` notification, check `lastActivity` and decide: re-arm another background `wait`, or intervene.

### `approve`

Resolve an `awaiting_input` / approval pause. No `tool_call_id` needed — the thread's pending call is used.

```bash
agnz approve abc allow --persist
```

`--persist` upgrades that tool to `allow` for the rest of this run, so you stop being paged for every `Edit`.

### `answer`

Resolve an `awaiting_input` / question pause (the sub-agent called `AskUser`).

```bash
agnz answer abc "Use the US English spelling."
```

### `interrupt`

Hard-interrupt a working/runaway agent: abort the current step (kills a runaway `Bash`/`Grep` too), leave the thread resumable, optionally queue a directive that drains on the next run.

```bash
agnz interrupt abc "Stop — the approach is wrong, use the existing helper instead."
```

### `stop` — end and archive a thread

Closes a thread: signals its runner if one is live, sets status `stopped`, and **keeps the transcript** on disk. A stopped thread drops out of the workspace list — and out of the summary the parent sees each prompt — so this is also the **cleanup verb**.

```bash
agnz stop devstral-e1b        # name or id — same addressing as send/wait
→ {"thread_id":"abc…","status":"stopped","note":"archived — transcript kept; resume with 'agnz send'"}
```

`stop` **archives, it does not delete.** The `.meta.json` + `.jsonl` stay on disk for later inspection — reach for `agnz show <id>` first; the transcript file itself is fenced against direct `Read` (see "Inspecting a thread" below). Use it when an `idle` thread's work is done and you won't resume it.

**Keeping the workspace legible.** Threads stay listed as long as they are *open* — and `idle` counts as open, like a paused conversation you can resume with `send`. Nothing decays them automatically; that is deliberate, so you never lose a thread you meant to continue. The flip side: finished threads you leave `idle` pile up in the parent's per-prompt summary and slowly cost context. The workspace block shows each thread's age (e.g. `idle · 3d`) and, once idle threads accumulate, a one-line reminder. The habit: when a sub-agent's job is truly done, `stop` it. Resuming later still works — the transcript is kept.

### `remove` — delete a thread permanently

The disposal path: deletes **every** file belonging to the thread (meta, transcript, trace — matched by filename prefix, so no companion file is ever left behind) and its index entry. Irreversible. Live threads (`running`/`awaiting_input`) must be `stop`ped first.

```bash
agnz remove old-probe             # one thread, by name or id
agnz remove --status stopped      # sweep: every archived thread in this workspace
agnz remove --status error        # sweep: every crashed thread
```

The workspace `messages.jsonl` is untouched — communication history survives its participants. Rule of thumb: `stop` when you're done, `remove` when you'd otherwise never look at it again.

All thread-addressing verbs (`send`, `wait`, `approve`, `answer`, `stop`, `remove`, `interrupt`, `show`) accept a **name or an id** interchangeably; a name resolves to its most recent live thread. A **unique id prefix** (≥ 4 chars, git-style) works too — the 8-char short ids shown in the lead block and `list` are directly usable; an ambiguous prefix is an explicit error, and a name always wins over a prefix.

### `list` / `show`

```bash
agnz list                 # threads in this workspace: name, status, summary, spend
agnz show abc             # lean structural view: status, pending, spend, trace stats
```

`show` strips the two heavy embedded fields (`systemPromptSnapshot`, the agent def's full body) that live in `meta.json`, and caps each recent-message excerpt at ~500 chars with an elision marker reporting the original size — a routine status check can never forward a full tool result. It also folds in the thread's trace stats (turns/tokens/latency/tool outcomes — the same aggregation `lib/trace-stats.mjs` computes) so one call answers "what is this thread, what did it do, how heavy is it" without a second lookup.

`list` opportunistically recovers threads whose runner died (a crash leaves no daemon to clean up) by marking them `error`.

## How results arrive

Every run is **detached**: `start`/`send`/`approve`/`answer` spawn a short-lived runner that works in the background and exits. The result reaches the parent via `SendMessage(to:"parent")` → `messages.jsonl` → the `UserPromptSubmit` hook injects unread parent mail into your next prompt. An OS notification fires for urgent mail. No polling.

For a status peek any time: `agnz show <id>`. To actually block for an outcome in the same call, use `agnz wait <id>` (see above) — it's a watcher polling the thread, not a second run mode; the detached runner is the only thing doing work.

## The three outcome states

`agnz show <id>` (or the meta file) reflects one of:

**1. `idle`** — the agent finished its turn; the distilled answer is in `content`. Send again to follow up.

**2. `awaiting_input` / approval** — the agent wants to run a gated tool (usually `Edit`/`Write`/`Bash`). Long string args are truncated to a length-annotated preview to protect your context; the full args stay in the meta under `pending.args`. Resolve with `agnz approve <id> allow|deny`. A deny is injected as the tool result and the agent continues — it may try another approach.

**3. `awaiting_input` / question** — the agent called `AskUser` because it genuinely could not decide. `options`/`context` may be present. Resolve with `agnz answer <id> "…"`.

## Inspecting a thread — ask before you read

The thread already carries its own context; reading its transcript costs *your* context, asking it a question costs *its* (local) tokens. Escalate in this order, cheapest first:

1. **The workspace summary block** — the `UserPromptSubmit` hook injection (ADR 0007). Free, already in your context, and often enough to see status and rough spend across every open thread.
2. **`agnz show <id>`** — the lean structural view above. One call, capped size, covers status/pending/spend/trace stats.
3. **Ask the thread directly** — `agnz send <name> "clarifying question"`. The thread has full context already; a targeted question is cheaper than pulling its history into yours.
4. **`inspect.sh`** (from the `agnz-threads` skill) as the last-resort debugging escape hatch — it tails the transcript/trace with its own caps.

Reading `<id>.jsonl`/`<id>.trace.jsonl` directly with `Read` is not a rung on this ladder for routine use, and a `PreToolUse` hook blocks it outright — a single transcript line can carry up to 512 KiB of verbatim tool output, the exact context this plugin exists to keep out of yours. `Grep` against those files still works (matches only, so it's cheap), and `meta.json` is still directly readable for a fast peek at `pending`.

## Concurrency — agents in parallel

Each detached run is its own OS process, so multiple agents run in genuine parallel:

```bash
agnz start auth    "Investigate how auth works"    --agent researcher
agnz start billing "Investigate how billing works" --agent researcher
# Both running as separate processes; results arrive via the hook at the next prompt.
```

Both finish in roughly max(A, B) wall time, not A+B. Nothing stays resident between runs — an idle thread is just files on disk.

## Error recovery

- **`status: "error"`.** Check `error.message` in the meta. Most common: the local runtime (LM Studio / Ollama / MLX) was down when the send fired. Start it and `agnz send` again — but an `error` thread is dead; `start` a fresh one (its transcript is preserved for inspection).
- **Wedged thread** (every send returns a jinja/alternation error). A previous send failed mid-turn and left the transcript in a state the model's template rejects. `stop` it and `start` fresh.
- **Wrong resolver** — `agnz approve` on a question pause (or vice versa) returns a clear error telling you which verb to use.
- **Runaway / babbling** — `agnz interrupt <id>` aborts it now; if the role prompt is too vague, edit the role file (see `defining.md`) and `start` a fresh thread (a running thread keeps its snapshot).

## Messages and mailboxes — agent↔agent communication

Sub-agents address each other by the `name` they were started with, via their always-allowed `SendMessage` tool. Messages land in `<cwd>/.claude/agnz/messages.jsonl`.

```
SendMessage({ to: "writer", kind: "handoff", text: "Investigation complete. Key files: lib/auth.js", urgent: false })
```

| Kind | Purpose |
|---|---|
| `say` | Informational — status update, FYI |
| `question` / `answer` | Ask another agent / respond |
| `handoff` | Pass work ownership |
| `status` | Structured progress signal |
| `error` | Report a failure |
| `directive` | Instruction from parent or lead agent |

Each sub-agent **drains its inbox at the top of every turn** — messages addressed to it are injected as synthetic user messages, and `inboxCursor` advances so nothing is redelivered. Agents reach the parent via `to: "parent"` (delivered by the hooks; `urgent: true` also fires an OS notification). The log is append-only; read `messages.jsonl` to debug communication.

## What is deliberately NOT available

- **No streaming.** Outcomes are single events; intermediate tool calls are invisible until the agent pauses or finishes. `agnz wait` blocks on the *outcome*, not on intermediate steps — you still don't see tool calls as they happen.
- **No daemon.** Nothing runs between runs; state lives in files.
- **`Bash` is gated.** Policy ships as `ask`; the first call pauses for approval. `agnz approve <id> allow --persist` unlocks it for the run. Note: Bash is **not** path-confined — it is the sandbox escape hatch, gated only by approval (ADR 0003).
- **No runtime reload of agent definitions.** A running thread keeps its snapshot; `start` a new thread to pick up edits.
