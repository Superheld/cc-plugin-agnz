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

`--inline "<frontmatter>"` defines an ad-hoc role instead of `--agent`. Without a task, the thread starts `idle`. `--wait` runs it inline and returns the outcome (see below). The thread is persisted at `<cwd>/.claude/agnz/threads/<id>.meta.json`, recoverable across runs.

### `send`

Send a task or follow-up. **Reuses** the most recent live thread of that name (resume), so a follow-up keeps its context; pass a thread-id to target one exactly.

```bash
agnz send researcher-1 "Now also check the test files."
→ {"thread_id":"abc…","status":"started"}   # or "queued" if the thread is mid-run
```

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

### `stop`

End a thread (signals its runner; the transcript persists).

```bash
agnz stop abc
```

### `list` / `show`

```bash
agnz list                 # threads in this workspace: name, status, summary, spend
agnz show abc             # full state + pending + last transcript messages
```

`list` opportunistically recovers threads whose runner died (a crash leaves no daemon to clean up) by marking them `error`.

## How results arrive

By default a run is **detached**: `start`/`send`/`approve`/`answer` spawn a short-lived runner that works in the background and exits. The result reaches the parent via `SendMessage(to:"parent")` → `messages.jsonl` → the `UserPromptSubmit` hook injects unread parent mail into your next prompt. An OS notification fires for urgent mail. No polling.

Pass **`--wait`** to block until the segment pauses/finishes and get the outcome JSON directly in the same call — best for short tasks. For a non-blocking status peek any time: `agnz show <id>`, or read the meta file directly.

## The three outcome states

`agnz show <id>` (or the meta file) reflects one of:

**1. `final`** — free text; the agent finished its turn and is idle. Send again to follow up.

**2. `awaiting_input` / approval** — the agent wants to run a gated tool (usually `Edit`/`Write`/`Bash`). Long string args are truncated to a length-annotated preview to protect your context; the full args stay in the meta under `pending.args`. Resolve with `agnz approve <id> allow|deny`. A deny is injected as the tool result and the agent continues — it may try another approach.

**3. `awaiting_input` / question** — the agent called `AskUser` because it genuinely could not decide. `options`/`context` may be present. Resolve with `agnz answer <id> "…"`.

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

- **No streaming.** Outcomes are single events; intermediate tool calls are invisible until the agent pauses or finishes (or use `--wait` to block for the segment).
- **No daemon.** Nothing runs between runs; state lives in files.
- **`Bash` is gated.** Policy ships as `ask`; the first call pauses for approval. `agnz approve <id> allow --persist` unlocks it for the run. Note: Bash is **not** path-confined — it is the sandbox escape hatch, gated only by approval (ADR 0003).
- **No runtime reload of agent definitions.** A running thread keeps its snapshot; `start` a new thread to pick up edits.
