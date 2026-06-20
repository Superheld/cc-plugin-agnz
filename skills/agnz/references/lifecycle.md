# Sub-agent lifecycle

Companion to [SKILL.md](SKILL.md). Details of the conversation flow between Parent Claude and an agnz sub-agent.

> **⚠ Outdated:** this file describes the removed **MCP tools** (`agent_*`/`thread_*`). agnz is now **CLI-only** — the verbs (`agnz start/send/approve/answer/stop/interrupt/list/show`) in [SKILL.md](SKILL.md) are authoritative. See [ADR 0014](../../../docs/adr/0014-cli-replaces-mcp.md). The *conversation flow* (background runs, pauses, results via the hook) below still applies; only the tool *names/invocation* changed (MCP tool → Bash CLI call).

## The six tools

All return JSON. Parent Claude calls them; the sub-agent doesn't see them.

### `agent_start`

Create a thread locked to a working directory.

```
agent_start({
  cwd: "/abs/path/to/project",    // required — the sandbox root
  agent: "researcher",            // optional — agent def name (ADR 0003)
  profile: "lmstudio-devstral",   // optional — ignored if `agent` is set
  system_prompt: "..."            // optional — ignored if `agent` is set
})
→ {
  thread_id: "abc...",
  cwd: "/abs/path/to/project",
  profile: "lmstudio-devstral",
  model: "mistralai/devstral-small-2-2512",
  policy: { Read: "allow", Edit: "deny", ... },
  agent: "researcher" | null
}
```

The thread is persisted at `<cwd>/.claude/agnz/threads/<id>.meta.json` and is recoverable across MCP restarts.

### `agent_send`

Send a user message (task or follow-up). Always returns immediately with `{status: "started"}`. Use `agent_wait` to collect the outcome.

```
agent_send({
  thread_id: "abc...",
  message: "Find all call sites of parseConfig and summarize.",
})
```

### `agent_approve`

Resolve an `awaiting_input` / `kind: "approval"` pause.

```
agent_approve({
  thread_id: "abc...",
  tool_call_id: "...",            // the id from the pending payload
  decision: "allow" | "deny",
  persist: false,                 // optional — upgrade tool to `allow` for the rest of the thread
})
```

`persist: true` is how you stop being paged for every single `Edit` after you've decided "yes this agent can edit".

### `agent_answer`

Resolve an `awaiting_input` / `kind: "question"` pause. The sub-agent called `AskUser` because it genuinely could not decide something on its own.

```
agent_answer({
  thread_id: "abc...",
  tool_call_id: "...",
  answer: "Use the US English spelling.",
})
```

### `agent_stop`

Mark the thread as stopped. In-memory sandbox state is dropped; the persisted transcript remains.

```
agent_stop({ thread_id: "abc..." })
```

## How results arrive

Agents always run in the background. Results come via `SendMessage(to: "parent")` — the `UserPromptSubmit` hook injects unread parent mail into your next Claude prompt. No polling, no blocking.

For a non-blocking status check at any time: read `<cwd>/.claude/agnz/threads/<id>.meta.json` directly.

## The three agent states

When an agent pauses or finishes, the meta file reflects one of these:

### 1. `status: "final"`

```
{
  status: "final",
  thread_id: "abc...",
  content: "Request logging is handled by middleware/logger.js...",
  finish_reason: "stop"
}
```

Free text. The sub-agent finished its turn and is idle. You can send again (follow-up), stop it, or leave it.

### 2. `status: "awaiting_input", kind: "approval"`

```
{
  status: "awaiting_input",
  kind: "approval",
  thread_id: "abc...",
  tool_call_id: "...",
  tool: "Edit",
  args: {
    path: "src/logger.js",
    old_string: "<string: 245 chars, head: \"function log(level, msg)...\">",
    new_string: "<string: 312 chars, head: \"function log(level, msg, meta)...\">"
  },
  hint: "Sub-agent wants to run a tool that needs consent..."
}
```

The sub-agent wanted to run a gated tool (usually `Edit` or `Write`). Long string args are truncated to a length-annotated preview to protect your context — the full args are always readable in `<cwd>/.claude/agnz/threads/<id>.meta.json` under `pending.args` if you need to audit.

Resolve with `agent_approve`. If you deny, the denial is injected as the tool result and the sub-agent continues — it may try a different approach.

### 3. `status: "awaiting_input", kind: "question"`

```
{
  status: "awaiting_input",
  kind: "question",
  thread_id: "abc...",
  tool_call_id: "...",
  question: "Should the new field be optional or required?",
  options: ["optional", "required"],
  context: "I'm editing the UserProfile type..."
}
```

The sub-agent called `AskUser`. `options` and `context` may be missing. Resolve with `agent_answer`.

## Concurrency — running agents in parallel

All calls (`agent_send`, `agent_approve`, `agent_answer`) return immediately with `{status: "started"}`. Agents run in the background via Node's event loop. You can kick off multiple agents without waiting for any of them.

### Two agents working in parallel

```
thread_A = agent_start({cwd, agent: "researcher"})
thread_B = agent_start({cwd, agent: "researcher"})

agent_send({thread_id: A, message: "Investigate how auth works"})
agent_send({thread_id: B, message: "Investigate how billing works"})

# Both are now running. Results arrive via SendMessage(to: "parent") at the next prompt.
```

Both finish in roughly max(A, B) wall time, not A+B.

### Peeking without waiting

If you just want to know where the sub-agent is right now without blocking, Read the thread meta file directly — no MCP call needed. The `status` field tells you everything (`running`, `awaiting_input`, `idle`, `stopped`, `error`), and `pending` tells you what kind of pause if any.

## Error recovery

**Thread returned `status: "error"`.** Check `error.message` in the thread meta for the cause. Most common: the local runtime (LM Studio / Ollama) was down when the send fired. Start the runtime and send again.

**Thread wedged — every send returns a jinja template / alternation error.** A previous send failed mid-turn and left the transcript in a state the model's prompt template rejects. No fix today; stop the thread and start a fresh one.

**Approval pause that you accidentally answered with `agent_answer`.** You'll get a clear error: "thread is awaiting approval, not question. Use agent_approve." Just retry with the right tool.

**Sub-agent won't stop narrating / keeps babbling.** Its role's system prompt is too vague. Edit the role file (see `defining.md`), start a fresh thread, retry. Snapshot-on-spawn means the running thread won't pick up the new prompt.

## Messages and mailboxes — agent↔agent communication

Sub-agents address each other by the `name` given at `agent_start`. Messages are sent via the `SendMessage` tool (always-allowed, no approval needed) and land in `<cwd>/.claude/agnz/messages.jsonl`.

### Sending a message

```
SendMessage({
  to: "writer",            // agent name, or "parent", or ["a", "b"] for broadcast
  kind: "handoff",         // see kinds below
  body: "Investigation complete. Key files: lib/auth.js, lib/tokens.js",
  urgent: false            // true → OS notification when addressed to parent
})
```

### Message kinds

| Kind | Purpose |
|---|---|
| `say` | Informational — status update, FYI |
| `question` | Ask another agent something; expect an `answer` back |
| `answer` | Response to a `question` |
| `handoff` | Pass work ownership to another agent |
| `status` | Structured progress signal |
| `error` | Report a failure to another agent or parent |
| `directive` | Instruction from parent or lead agent to a sub-agent |

### Receiving messages

Each sub-agent drains its inbox at the **top of every turn**. Messages addressed to it (`to` matches the agent's name) are injected as synthetic user messages. The `inboxCursor` advances so the same message is never redelivered across MCP restarts.

### Parent as recipient

Agents message the parent via `to: "parent"`. The `UserPromptSubmit` and `SessionStart` hooks (auto-enabled by the plugin) inject unread parent-addressed mail into Claude's context at the next prompt submission or session start. No polling needed.

Set `urgent: true` on a message to also fire an OS notification (macOS/Linux).

### Inspecting the message log

```
Read <cwd>/.claude/agnz/messages.jsonl
```

The log is append-only. Each line is `{ id, ts, from, to, kind, body, urgent? }`. Useful for debugging agent communication without blocking on MCP calls.

## What is deliberately NOT available

- **No streaming.** Outcomes are single events. Intermediate tool calls are invisible to the parent until the sub-agent pauses or finishes.
- **No `agent_status` / `agent_list_threads`.** Read the files; the MCP surface is for live-process operations only.
- **`Bash` is gated.** Policy ships as `ask` — the first call pauses for parent approval. Use `persist: true` on the first `agent_approve` to unlock for the rest of the thread.
- **No runtime reload of agent definitions.** A running thread keeps its snapshot. Start a new thread to pick up edits.
