# ADR 0002: Communication — mailboxes, events, and parent notification

- **Status:** Proposed
- **Date:** 2026-04-08
- **Branch:** `refactor/workspace-first-architecture`
- **Depends on:** [ADR 0001](./0001-workspace-first-architecture.md)

## Context

ADR 0001 establishes the workspace as the unit of persistent state and shrinks MCP to process-lifecycle verbs. It is silent on the one question that defines whether a *team* of agents is actually possible: **how do participants communicate?**

The constraints we are working against:

1. **Agent history is the most expensive thing we have.** Every turn of a sub-agent re-sends its full transcript to the LLM endpoint. Whatever a sub-agent "hears" each turn enters its history and lives there for the rest of the thread. Broadcast-to-everyone models are therefore toxic: they pollute every agent's context with traffic they do not need.

2. **Claude Code's harness has a firm ceiling.** Nothing — no MCP server, no hook, no background bash, no desktop notification — can push text into a reply that Claude is currently generating. New information only reaches the parent at well-defined moments: the next user prompt, the next session start, the next tool result the parent requested. Any "real-time" story for the parent is in fact "next-turn" at best.

3. **Agents may outlive CC sessions.** We want agents to continue working when the user closes Claude Code, and to be able to alert the user (and through the user, Claude) that something is ready. This needs a wake-up path that survives process boundaries.

4. **We will not use undocumented or brittle mechanisms.** No terminal keystroke injection, no hijacked IDE websockets, no `tmux send-keys` trickery. Only facilities Claude Code officially exposes: hooks, slash commands, MCP, bash, and OS-level notifications.

## Decision

Communication is modelled as an **event bus** with **per-recipient mailboxes**. The bus is an in-process primitive inside the MCP server; `messages.jsonl` is its durable audit log and its inter-process bridge.

### 1. The event bus

A module-level pub/sub primitive inside the MCP server process:

- **Topic = recipient name.** A recipient is an agent name, the literal string `parent`, or the wildcard `*` (broadcast).
- **Publish:** `bus.publish(message)`. The bus fans out to all matching subscribers (all `*` subscribers plus any direct-to-name subscribers).
- **Subscribe:** `bus.subscribe(recipient, handler)`. Each active thread subscribes under its agent name when its loop starts and unsubscribes when the thread ends.
- **Delivery to sub-agents is lazy.** The subscriber's handler does not run immediately on publish — it appends to an in-memory per-recipient queue. The agent loop drains that queue at the top of each turn, injects the messages into the turn's context as "new mail since your last turn," and advances the cursor.
- **The parent has no in-memory subscriber.** The parent reaches the bus only through files and hooks (see below).

This design gives agents event-driven delivery without per-turn polling, while keeping their context bounded to exactly the messages addressed to them.

### 2. `messages.jsonl` as the durable layer

Every `bus.publish` additionally appends the message to `<cwd>/.claude/agnz/messages.jsonl` as a single JSON line. This file is:

- **Append-only.** Never mutated, never rewritten in place.
- **The source of truth after a server restart.** On boot, the server rebuilds the in-memory bus state (specifically: nothing — active subscribers are re-registered when threads resume; the file is consulted only to serve parent-side reads and to resolve per-recipient cursors).
- **The parent's view into the bus.** The parent process (Claude, hooks, slash commands, ad-hoc `Read`) consults `messages.jsonl` directly — the bus does not run in the parent's process.
- **Sharable.** If a second component (a daemon, a bash script, a future multi-process host) needs to consume messages, it reads the same file. No API to maintain.

### 3. Cursors

Each recipient has a cursor indicating the last message it has "consumed":

- **Sub-agents:** cursor lives in the thread meta file (`<thread-id>.meta.json`) as `inboxCursor: <last-message-id>`. Advanced by the loop after injection. Persisted so that a server restart does not re-deliver old messages.
- **Parent:** cursor lives in `<cwd>/.claude/agnz/cursors/parent.json`. Advanced by the `UserPromptSubmit` and `SessionStart` hooks after they inject unread messages into Claude's context. The parent can advance it manually by writing the file, or reset it to re-read history.

### 4. Message schema

```json
{
  "id": "m000042",
  "at": "2026-04-08T21:05:00.123Z",
  "from": "researcher",
  "to": "parent",
  "kind": "status",
  "text": "t7 finished, summary written to notes",
  "item_id": "t7",
  "ref": null,
  "urgent": false
}
```

- **`id`**: monotonic per-workspace, format `m000000`. Not global — allows parallel workspaces to coexist.
- **`from`**: agent name or `parent`.
- **`to`**: agent name, `parent`, `*`, or an array of the above.
- **`kind`**: **fixed vocabulary** (see below). New kinds require an amendment to this ADR.
- **`text`**: free-form body. Should be short — this will live in agent context if addressed to them.
- **`item_id`**: optional reference to a board item (ADR 0003 territory, reserved here).
- **`ref`**: optional reference to another message's `id` (for threading: answers reference questions).
- **`urgent`**: boolean, default `false`. When true *and* `to` includes `parent`, triggers an OS-level notification (see §6).

### 5. Kind vocabulary (fixed)

| Kind | Use |
|---|---|
| `say` | Free-form statement, no response expected. |
| `question` | Sender expects an `answer` in response. |
| `answer` | Reply to a `question`. Must set `ref`. |
| `handoff` | Transfers responsibility for an item. Usually carries `item_id`. |
| `status` | Progress update on current work. Typical use for `to: "*"`. |
| `error` | Something went wrong. Often `urgent: true` when addressed to parent. |
| `directive` | Instruction from parent (or a coordinating agent) to change course. |

Kinds are load-bearing for two reasons:
- **Context management (future ADR):** the context-window manager can filter aggressively by kind — e.g. drop old `status` messages before dropping old `question`/`answer` threads.
- **Notification filtering:** `urgent` + specific kinds drive when an OS notification fires.

### 6. Parent notification strategy

Three cooperating mechanisms. All are required for the "no fire-and-forget" goal; each covers a different CC state.

#### 6a. `UserPromptSubmit` hook — near-real-time while active

Fires every time the user submits a prompt to Claude Code. The hook:

1. Reads `<cwd>/.claude/agnz/messages.jsonl`.
2. Collects all messages with `to ∋ parent` and `id > parent_cursor`.
3. If non-empty, writes them (formatted) to stdout, which CC injects into Claude's context alongside the user's prompt.
4. Updates the cursor in `<cwd>/.claude/agnz/cursors/parent.json`.

Effect: whenever the user sends any message, Claude sees the accumulated agent traffic since the last interaction. Latency = time between prompts.

#### 6b. `SessionStart` hook — wake-from-cold

Fires when a Claude Code session starts. The hook:

1. Reads `workspace.json` and produces a compact summary (members, mode, board state).
2. Reads unread `to:parent` messages from `messages.jsonl`.
3. Emits both as initial context so Claude's very first response of the session already knows the state.
4. Updates the parent cursor.

Effect: opening a closed CC session is sufficient for Claude to pick up where agents left off, without the user needing to ask.

#### 6c. OS notification on `urgent` messages — wake the human

When `bus.publish` receives a message with `urgent: true` and `to` including `parent`, the server additionally runs a platform-appropriate notification command:

- **macOS:** `osascript -e 'display notification "..." with title "agnz"'`
- **Linux (freedesktop):** `notify-send "agnz" "..."`
- **Other:** no-op (fallback: the message is still in `messages.jsonl` and will be seen via 6a/6b on next interaction).

Effect: the user is pulled back to Claude Code by the OS notification. When they open or return to CC, 6a or 6b then surfaces the content to Claude.

This is the chain: **agent → message → OS notification → user → CC → hook → Claude.** Indirect, but each hop is a mechanism CC officially supports, and the total latency from "agent finishes" to "Claude knows" is bounded by how long it takes the user to glance at their screen.

### 7. Sub-agent interface

Sub-agents get **one** new tool:

```
send_message(to, kind, text, item_id?, ref?, urgent?)
```

That is the entire publishing API. Reading is automatic: the agent loop injects new mail at the top of each turn. There is no `read_messages` tool — the agent does not need one, and adding one would invite the agent to re-read old messages and bloat its context.

### 8. Parent interface

The parent (Claude or the human directly) publishes messages via two paths:

- **Slash command:** `/agnz:say <to> [kind=<kind>] <text>` — a wrapper that writes to `messages.jsonl` and triggers the bus. Ergonomic for Claude and the user.
- **Direct write:** the parent may append a properly-formatted line to `messages.jsonl` using the standard `Write` tool. The bus polls the file at a low frequency (once per MCP request cycle) to pick up externally-added messages. This is the escape hatch for scripts, automation, and debugging.

Reading is via the `UserPromptSubmit` / `SessionStart` hooks (automatic) or on-demand:

- **Slash command:** `/agnz:inbox` — shows unread `to:parent` messages and optionally advances the cursor.
- **Direct read:** `Read` on `messages.jsonl` — the user or Claude can inspect the raw log at will.

### 9. Hooks are part of the plugin

The `UserPromptSubmit` and `SessionStart` hook scripts ship with the plugin under `scripts/hooks/`. They are **not** auto-installed into `~/.claude/settings.json` — the user must opt in, and this is documented. The reason: hooks that mutate Claude's context are powerful and invisible, and we owe the user an explicit opt-in.

## Consequences

### Positive

- **Agents see only their own mail.** Context growth scales with traffic *for them*, not total workspace traffic. This is the biggest lever on token cost and history discipline.
- **The event-system feel is real, not simulated.** Agent-to-agent delivery through the in-process bus is microsecond-scale. The "file" part is only for persistence and cross-process sharing.
- **One source of truth.** `messages.jsonl` is the durable log for humans, hooks, debug tooling, and future alternate hosts. No hidden state.
- **No new transport protocols.** The "API" for sending messages is a single tool (`send_message`) or a file append. Nothing to learn for callers outside the sub-agent loop.
- **The parent notification chain uses only official mechanisms.** Hooks and OS notifications are stable, documented facilities. No terminal hacks, no brittle IDE integration.
- **Multi-process migration is deferred, not blocked.** If we later run agents as standalone OS processes, they use the same `messages.jsonl` file and the same schema. The in-memory bus becomes optional — a perf optimisation for co-located agents — rather than load-bearing.

### Negative

- **Parent-side delivery is not mid-reply.** The user's next prompt is the earliest Claude sees new messages (via the `UserPromptSubmit` hook). For a user walking away for five minutes, that is fine. For a "please interrupt your current answer, I have bad news" scenario, it is not possible under any transport we are willing to use. This is a CC architectural constraint we accept.
- **Hooks are global to the user's CC install.** Installing our hooks means they fire on every CC session, not just sessions where agnz is active. The hook scripts must handle the "no agnz workspace in this project" case as a fast no-op and never block the prompt flow. This is cheap to implement but is a correctness requirement we must enforce with a test.
- **The in-memory bus and the file log can diverge on crash.** If the process dies between `bus.publish` firing listeners and the append to `messages.jsonl` completing, one subscriber may have seen the event while the file does not reflect it. The mitigation is: append to the file *first*, then fan out to subscribers. Any publish failure before the append aborts the publish; any failure after means subscribers have seen a durable event. Cost: a tiny per-publish latency increase.
- **No message expiration.** `messages.jsonl` grows unboundedly. A "workspace hygiene" ADR must address retention (rotate to `messages.jsonl.archive` after N days? Compact by kind?) before we ship to users with long-lived workspaces. Flagged as open.

### Neutral

- **The MCP tool surface does not shrink by this ADR.** It is not the job of 0002. `send_message` is a *sub-agent* tool, not an MCP tool — it is available only inside the sub-agent's loop, not callable from the parent over MCP. The parent uses slash commands, hooks, and direct file I/O. The MCP surface shrinks under ADR 0001's direction (process lifecycle only), not here.

## Deferred / Open questions

These are intentionally not decided in this ADR.

- **Message retention and rotation.** How large does `messages.jsonl` get before we compact or archive? Per-workspace or per-time policy? Will be resolved in a future "workspace hygiene" ADR.
- **Context-window management per agent.** How aggressively do we trim an agent's turn history when mail grows? What kinds get dropped first? Will be resolved in a future "context management" ADR. This ADR's `kind` vocabulary is designed so that that future decision has hooks to work with.
- **Role-based recipients (e.g. `to: "role:researcher"`).** The schema allows `to` to be a string or array of strings. Extending it to allow role or pattern matching is a future refinement, gated on whether teams with multiple instances of the same role are common enough to need it.
- **Broadcast-scoped vocabulary.** Whether some kinds (`directive`?) should be restricted to parent-only or specific senders. Likely yes, but not now.
- **Transactional writes to `messages.jsonl`.** If we later have two processes writing to the file (the MCP server and a standalone agent process), we need a locking strategy. The current design is single-writer (MCP server only); re-visit this when multi-writer becomes real.

## Interaction with ADR 0001

This ADR extends the workspace directory layout proposed in 0001:

```
<cwd>/.claude/agnz/
├── workspace.json
├── messages.jsonl              ← NEW: durable event log
├── cursors/
│   └── parent.json             ← NEW: parent's read position
├── threads/
│   ├── <id>.meta.json          ← extended: inboxCursor field
│   └── <id>.jsonl
└── scratch/
```

The `log.jsonl` file proposed (and then redesigned away from) in the earlier discussion is **not** in this layout. There is one and only one communication log: `messages.jsonl`. If later we decide we also need a lower-level operational log (tool calls, state transitions, errors without a `from`/`to`), that will be a separate ADR and a separate file.
