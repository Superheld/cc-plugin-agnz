# Sub-agent lifecycle

Companion to [SKILL.md](SKILL.md). Details of the six MCP tools and the conversation flow between Parent Claude and an agnz sub-agent.

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

Send a user message (task or follow-up).

```
agent_send({
  thread_id: "abc...",
  message: "Find all call sites of parseConfig and summarize.",
  detach: false                   // default: block until done/paused
})
```

Three possible outcomes (see below).

### `agent_approve`

Resolve an `awaiting_input` / `kind: "approval"` pause.

```
agent_approve({
  thread_id: "abc...",
  tool_call_id: "...",            // the id from the pending payload
  decision: "allow" | "deny",
  persist: false,                 // optional — upgrade tool to `allow` for the rest of the thread
  detach: false                   // optional — like agent_send
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
  detach: false
})
```

### `agent_wait`

Block on a detached thread until its next event.

```
agent_wait({
  thread_id: "abc...",
  timeout_ms: 30000              // optional — returns {status: "still_running"} if no event
})
```

Multiple concurrent waits on the same thread are safe.

### `agent_stop`

Mark the thread as stopped. In-memory sandbox state is dropped; the persisted transcript remains.

```
agent_stop({ thread_id: "abc..." })
```

## The three outcomes

Every sync `agent_send` / `agent_approve` / `agent_answer` returns exactly one of these:

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

## The detach + wait pattern — concurrency

Every resolving call (`agent_send`, `agent_approve`, `agent_answer`) accepts `detach: true`. When set, the call returns immediately with `{status: "started"}` and the sub-agent runs in the background. You then pick it up later with `agent_wait(thread_id)`.

Why bother: while a sub-agent awaits a `fetch()` to the local LLM, Node's event loop is free. You can kick off a second sub-agent in parallel, do your own work in the main Claude thread, or poll thread state via Read on the meta files.

### Two agents working in parallel

```
thread_A = agent_start({cwd, agent: "researcher"})
thread_B = agent_start({cwd, agent: "researcher"})

agent_send({thread_id: A, message: "Investigate how auth works",   detach: true})
agent_send({thread_id: B, message: "Investigate how billing works", detach: true})

outcome_A = agent_wait({thread_id: A})
outcome_B = agent_wait({thread_id: B})
```

Both finish in roughly max(A, B) wall time, not A+B.

### A long editor you don't want to block on

```
agent_send({thread_id: E, message: "Rename requestId to traceId across the service", detach: true})
# ... do something else in Parent Claude ...
outcome = agent_wait({thread_id: E, timeout_ms: 60000})
if outcome.status === "still_running":
  # keep waiting, or come back later
```

### Peeking without waiting

If you just want to know where the sub-agent is right now without blocking, Read the thread meta file directly — no MCP call needed. The `status` field tells you everything (`running`, `awaiting_input`, `idle`, `stopped`, `error`), and `pending` tells you what kind of pause if any.

## Error recovery

**Thread returned `status: "error"`.** Check `error.message` in the thread meta for the cause. Most common: the local runtime (LM Studio / Ollama) was down when the send fired. Start the runtime and send again.

**Thread wedged — every send returns a jinja template / alternation error.** A previous send failed mid-turn and left the transcript in a state the model's prompt template rejects. No fix today; stop the thread and start a fresh one.

**Approval pause that you accidentally answered with `agent_answer`.** You'll get a clear error: "thread is awaiting approval, not question. Use agent_approve." Just retry with the right tool.

**Sub-agent won't stop narrating / keeps babbling.** Its role's system prompt is too vague. Edit the role file (see `defining.md`), start a fresh thread, retry. Snapshot-on-spawn means the running thread won't pick up the new prompt.

## Messages and mailboxes — agent↔agent communication

Sub-agents can send messages to each other (and to the parent) via the `SendMessage` tool. The messages land in `<cwd>/.claude/agnz/messages.jsonl`. Each sub-agent automatically drains its inbox at the top of every turn — messages addressed to it get injected as synthetic user messages, and the thread's `inboxCursor` advances so the same message is not redelivered.

Key vocabulary on a message: `kind` ∈ `say | question | answer | handoff | status | error | directive`. The schema is in the `workspace` skill's reference.

For the parent to see mail, enable the `UserPromptSubmit` and `SessionStart` hooks that ship with the plugin — see the top-level readme.

## What is deliberately NOT available

- **No streaming.** Outcomes are single events. Intermediate tool calls are invisible to the parent until the sub-agent pauses or finishes.
- **No `agent_status` / `agent_list_threads`.** Read the files; the MCP surface is for live-process operations only.
- **`Bash` is gated.** Policy ships as `ask` — the first call pauses for parent approval. Use `persist: true` on the first `agent_approve` to unlock for the rest of the thread.
- **No runtime reload of agent definitions.** A running thread keeps its snapshot. Start a new thread to pick up edits.
