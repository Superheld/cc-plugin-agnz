# ADR 0004: Board — mini-scrum for shared work

- **Status:** Proposed
- **Date:** 2026-04-08
- **Branch:** `refactor/workspace-first-architecture`
- **Depends on:** [ADR 0001](./0001-workspace-first-architecture.md), [ADR 0002](./0002-communication-mailbox-and-events.md), [ADR 0003](./0003-agent-definitions.md)

## Context

A flat todo list does not scale to a team. As soon as more than one agent is working in a workspace — or the parent wants to see *what is happening right now* versus *what is waiting* versus *what needs sign-off* — the shape "array of items with a status field" collapses into noise. The natural model is a small kanban board: a single list of items, each with a state, an owner, and a discussion thread of its own.

The existing todo concept from earlier discussion is therefore subsumed. There are no separate todos; there are only **board items**. A todo, in the flat sense, is the degenerate case of a board item with no owner and a single `backlog → done` transition.

We want the minimum that makes a team flow work: states for items, owners for accountability, a review gate so the parent can stop the team from marking its own work done, a per-item discussion that lives with the item instead of in the global message log, and a workspace-level flag that lets us tell the team "stop executing, just plan" without a pause mechanism.

## Decision

The workspace has a **board**: a single array of items, each with a column, an owner, and a notes thread. The board is stored as a field of `workspace.json`. Agents and the parent manipulate the board through a small, symmetric set of operations.

### 1. Board items

Each item is an object in the `workspace.json` `items` array:

```json
{
  "id": "t042",
  "title": "Add todo_edit tool to sub-agent",
  "description": "Markdown body — optional, for longer context. Can reference files, paste snippets, link to prior items.",
  "column": "in_progress",
  "owner": "researcher#abc123",
  "createdBy": "parent",
  "createdAt": "2026-04-08T20:00:00Z",
  "updatedAt": "2026-04-08T20:03:00Z",
  "deps": ["t038", "t040"],
  "notes": [
    { "at": "...", "by": "parent", "text": "Prio high, stick to ADR 0002 schema." },
    { "at": "...", "by": "researcher#abc123", "text": "Picked up. Starting with t038's output." }
  ],
  "tags": ["comms", "sub-agent-tool"]
}
```

**Fields:**

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | `t000` — `t999` — monotonic per workspace. Short so humans can type them. |
| `title` | yes | One line. What the item is. |
| `description` | no | Longer markdown body. Empty string if nothing to add. |
| `column` | yes | One of `backlog`, `planned`, `in_progress`, `review`, `done`, `cancelled`. |
| `owner` | conditional | Agent name (role-scoped) OR thread id (`name#shortid`) OR `parent` OR `null`. Required for any column except `backlog` and `cancelled`. |
| `createdBy` | yes | `parent` or a thread id. Who added the item. |
| `createdAt`, `updatedAt` | yes | ISO timestamps. Updated on every mutation. |
| `deps` | no | Array of item ids this item depends on. Empty array if none. Enforcement is soft (see §5). |
| `notes` | yes | Array of `{at, by, text}` entries. Append-only discussion thread local to the item. |
| `tags` | no | Array of free-form strings. For filtering in board views. No semantic meaning. |

**Owner addressing:**

- A **role name** like `researcher` means "any researcher instance can pick this up." Used for backlog and planned items that are not yet claimed by a specific thread.
- A **thread id** like `researcher#abc123` means "this specific instance is working on it." Used once an item moves to `in_progress`. This matches the rule in ADR 0003 §6.
- `parent` is a valid owner — some items are things Claude or the human does directly, not delegated to an agent.
- `null` is only valid in `backlog` and `cancelled`.

### 2. Columns

Fixed vocabulary:

| Column | Meaning | Who moves items here? |
|---|---|---|
| `backlog` | Captured, not yet committed to. May be vague. | Anyone. |
| `planned` | Committed to, ready to pick up, but not yet started. | Anyone. |
| `in_progress` | Currently being worked on. | Usually the agent claiming it. |
| `review` | Work finished from the agent's side, awaiting sign-off. | The agent that finished. |
| `done` | Signed off by the parent. | Only the parent (in review-gated mode). |
| `cancelled` | Not going to be done. Rationale should be in notes. | Anyone. |

Transitions are unrestricted *in the code* — agents can move items between any two columns — but **constrained by the system prompt and by the review gate** (see §3). Specifically, agents are instructed to follow the ordering `backlog → planned → in_progress → review` and to leave `done` to the parent unless the workspace's review gate allows otherwise.

`planned` is optional. If you don't need a sprint-commit step, items can go directly from `backlog` to `in_progress`. `planned` exists for projects where you want an explicit "this is the current batch" distinction.

### 3. The review gate

A field on `workspace.json` at the root:

```json
{
  "reviewRequired": "mutations-only"
}
```

Values:

- `"always"` — every item must pass through `review` before `done`. No agent may move an item directly to `done` under any circumstance. Parent is the only mover to `done`.
- `"mutations-only"` (default) — items whose owner ever ran a mutating tool (`edit_file`, `write_file`, or a future `bash`) must go through `review`. Pure read/research items may be moved directly to `done` by the agent. Tracked by a per-item boolean `mutated` (set by the tool loop when a mutating tool is invoked during ownership).
- `"never"` — agents may move items directly to `done`. The `review` column still exists and can be used voluntarily, but is not enforced.

Enforcement is at the **`board_move` tool level**: when an agent calls `board_move(id, "done")`, the server checks the gate and either allows the move or rejects the call with an explanation. This is the one place where we enforce workflow in code rather than via system prompt.

Per-agent override: an agent definition (ADR 0003) may set `reviewRequired: true` on itself, forcing its items through review even if the workspace setting is `"never"`. The stricter of workspace and agent wins.

### 4. Ownership and pull semantics

Who can assign items to whom:

- **The parent can assign any item to any owner.** Explicit push.
- **An agent can claim an unowned item for itself.** `board_assign(id, self)` where `self` is the agent's own thread id. This is the default flow: agents pull work from the backlog/planned column into their own `in_progress`.
- **An agent cannot assign to another agent.** No push between agents. If agent A wants agent B to do something, A sends a `handoff` message (ADR 0002) with an `item_id`, and B picks it up on its next turn. The receiving agent decides whether to `board_assign` it to itself.

The reason: in a mixed team of local models with varying competence, one dumb agent pushing work on a smarter one creates feedback loops. Pull preserves each agent's own judgment about what it can handle.

### 5. Dependencies

An item with a non-empty `deps` array is **blocked** until every item in `deps` is `done` or `cancelled`. Enforcement is soft:

- The agent's context at each turn includes the resolved status of any items in its current item's `deps`.
- The system prompt tells agents: "Do not start an item whose dependencies are not yet resolved. If you are tempted to, mark the current item as `blocked` in notes and return to the backlog."
- We do **not** reject `board_move` to `in_progress` when deps are unresolved. Agents may violate the soft rule — we rely on the system prompt and on the parent's review.

The reason to keep enforcement soft: hard enforcement would require dependency graph validation on every mutation, and would prevent legitimate cases (e.g. an agent that starts reading upstream code while waiting for a dep to finish). The soft model keeps the rule as documentation for the agent's planning, not a code constraint.

### 6. The `planning` mode on the workspace

A second field at the root of `workspace.json`:

```json
{
  "mode": "planning"
}
```

Values: `"planning"` or `"executing"`. Default: `"executing"`.

**In `planning` mode:**

- Agents are instructed (via system prompt) to analyse, read, search, propose items, and move them into `backlog` or `planned`.
- Mutating tools (`edit_file`, `write_file`, future `bash`) are **temporarily downgraded to `deny`** regardless of profile or agent definition. The `checkPermission` function consults the workspace mode before returning its decision.
- `board_move` to `in_progress` is allowed — agents can start "investigating" an item without editing — but any attempted mutation from within that work pauses with `awaiting_input` and a message explaining the mode.
- Read tools (`list_dir`, `read_file`, `grep`) are unaffected.

**Flipping the mode:**

- The parent writes to `workspace.json` directly, via a slash command `/agnz:mode planning|executing`, or via a dedicated MCP tool if we need one (see §9 open questions).
- Agents may not flip the mode themselves. This is a parent-only lever.
- Flipping to `executing` is "green light — go work." Flipping back to `planning` mid-run is "stop mutating, regroup." Running agents see the new mode at their next turn.

### 7. Sub-agent tools

Four tools, added to the sub-agent's tool registry:

| Tool | Shape | Effect |
|---|---|---|
| `board_add` | `(title, description?, deps?, tags?)` | Create a new item in `backlog` with `createdBy = self`. Returns the new item id. |
| `board_move` | `(id, column, note?)` | Move an item to a new column. Optional `note` is appended to the item's `notes` as the rationale (`by = self`). Validates the review gate for `done` transitions. |
| `board_note` | `(id, text)` | Append a note to an item without moving it. Used for progress updates, questions to the parent, observations. |
| `board_assign` | `(id, owner)` | Set ownership. `owner` must be `self` (the agent's own thread id) unless the agent is somehow marked as a coordinator — not in scope for this ADR; today, only `self` is valid, enforced at tool level. |

These are the **only** board mutation points for sub-agents. Reading the board is automatic: each turn, the agent's context includes (a) a compact summary of the whole board (columns + counts), (b) the full details of any item the agent owns, and (c) the full details of any item referenced in its current turn's messages (ADR 0002). We do not give agents a `board_read` tool for the same reason we don't give them a mail-read tool — free re-reading bloats history.

### 8. Parent interface

The parent (Claude or the human directly) reads and writes the board via files and slash commands. No MCP tools are added for parent-side board operations.

**Reading:**
- `/agnz:board` — renders the board as a compact column view. Reads `workspace.json`, formats, prints. Pure bash/script, no MCP.
- `Read` on `workspace.json` — raw inspection.
- `/agnz:item <id>` — shows a single item's full details including notes.

**Writing:**
- `Edit` or `Write` on `workspace.json` — direct modification. This is the escape hatch: the parent can fix a stuck item, retitle something, reorder, whatever.
- `/agnz:board-add <title>` — convenience for adding items.
- `/agnz:board-move <id> <column>` — convenience for state transitions.
- `/agnz:mode planning|executing` — flip the workspace mode.

The symmetry is deliberate: agents and the parent see the same file, operate on the same fields, but through different interfaces matching their different contexts (tools for agents, slash commands and raw file I/O for the parent).

### 9. Storage and concurrency

The board is a field of `workspace.json`. This means **every board mutation rewrites the file**. This is acceptable for the scale we expect (tens to low hundreds of items, handful of mutations per minute) and keeps the mental model simple: one file = one state snapshot.

**Concurrent writes** are handled with a simple lock: before writing, the caller acquires `workspace.json.lock` (atomic create of the lock file, fail if it already exists, retry with short backoff up to N times). The lock holder reads the current file, mutates, writes, releases. Any writer — MCP server, slash command, human with an editor — must respect the lock.

A lock-file approach was chosen over atomic rename (write-to-tmp, rename) because the rename pattern handles writer-vs-writer but not reader-vs-writer consistency, and we want agent reads to see a settled state. The lock-file approach is slightly more latency but dramatically simpler to reason about.

If the file grows beyond comfort (items in the thousands, which is very unlikely for our use case), we can split `items` into a separate file `board.json`. Not doing it now: one file is more honest about "this is your workspace state."

### 10. What this ADR does not include

- **No sprints as time-bounded cycles.** `planned` is a commit-to-batch column, not a sprint with a duration or velocity tracking. We do not measure burndown, we do not set sprint length, we do not hold retros.
- **No estimation.** No story points, no time estimates, no priority numbers. If you need to order work, re-order the `items` array — the display is in array order within each column.
- **No cross-workspace item references.** Items are workspace-local. No `deps` into another workspace, no "blocked by project X's item 42."
- **No auto-created items from messages.** A `question` message referring to `item_id: t42` does not automatically create t42 if it doesn't exist. Items are created deliberately.
- **No item templates.** If you find yourself creating the same kind of item often, write a slash command that wraps `board_add` with a prefilled title and description.

## Consequences

### Positive

- **One unified model replaces todos, tasks, stages, and team coordination.** An item moves through columns, has an owner, and carries its own discussion. This is enough to see state, distribute work, and review results without needing a second data structure.
- **Planning mode is a real safety feature.** A single `workspace.json` field toggles whether agents can mutate anything. The parent can say "stop, we're replanning" mid-run without killing threads.
- **The review gate is where quality control actually lives.** Agents finish into `review`, not into `done`. The parent signs off. This is a concrete manifestation of the "no fire and forget" goal — every unit of work lands on the parent's desk before it is considered complete, unless the parent has opted out per workspace.
- **Pull semantics match how competent teams actually work.** Agents claim what they can handle. No agent is forced to take on work another agent pushed at them.
- **Parent interface is symmetric with agents' but through files.** Nothing stops the human user from opening `workspace.json` in VS Code and editing the board directly. That is a feature — the workspace really is a shared thing, not a puppet strung by MCP.
- **Notes live with items.** An item's discussion follows it through its lifecycle — onto `done`, into history, off the board view but still in the file. Context is never lost to the global log.

### Negative

- **Rewriting `workspace.json` on every mutation is I/O chatty.** For the scale we expect this is fine; on a workspace with dozens of items and dozens of mutations per minute, the file is still well under 100kb. If it ever becomes a problem, we split items into their own file.
- **The lock file is a new failure mode.** A crashed server that held the lock leaves a stale `workspace.json.lock`. Mitigation: on boot, the MCP server clears any lock older than N seconds belonging to its own pid file. The `/agnz:*` slash commands also check for stale locks before waiting.
- **No built-in prioritisation.** Re-ordering the array by hand (or by slash command) is the only way to express "do this before that." This is fine for small boards and annoying for large ones. If a board grows past ~50 items, the real answer is probably "break it into stages" rather than "add priority numbers."
- **Agents can violate the workflow rules (move to `done` out of column order, skip review, etc.) in `"never"` mode.** This is intentional — we trust the combination of system prompt and review discipline, and we keep the enforcement burden low. The strict answer is to run with `reviewRequired: "always"`.

### Neutral

- **No CRDT or merge semantics.** Concurrent mutations are serialised by the lock file. If two agents try to claim the same item at the same time, one wins and the other gets a clean "already owned" error. This is simpler than the alternative and the alternative is not worth the cost at our scale.
- **The board is stateful, messages are append-only.** This means the board tells you the current picture; `messages.jsonl` tells you the history of how we got here. Both are needed. Neither replaces the other.

## Deferred / Open questions

- **Priority and ordering.** Do we add a `priority` field (high/med/low) or stay with "array order is priority"? Deferred until a user actually asks for it.
- **Archive of `done` items.** Does an item stay in `done` forever? Move to a separate `workspace.archive.json`? Tied to the broader retention / hygiene ADR that also governs `messages.jsonl`.
- **Template items for recurring work.** If a team does the same kind of item over and over, should we support templates? Likely yes, but as a slash command rather than a code feature.
- **Cross-agent coordination beyond pull.** What if two agents both need to work on related items — does the board model enough, or do we need a "shared ownership" concept? Defer until we actually see the problem with the current model.
- **Dedicated MCP tools vs. slash commands for parent board operations.** This ADR says slash commands + direct file I/O. If that turns out ergonomically rough for Claude (too many `Read`/`Edit` calls for routine operations), we can add a small MCP tool set in a later amendment. Not now — start simple.
- **Review in the `"mutations-only"` mode: what exactly counts as a mutation?** `edit_file` and `write_file` obviously. A future `bash` tool clearly does. But: is `ask_user` a mutation? (No.) Is `send_message` a mutation? (Debatable — it modifies shared state.) We pick a conservative answer: "mutation" means a tool call whose policy is not `allow` under the default profile. `ask_user` and `send_message` are `allow` everywhere, so they do not count. Revisit if the list changes.

## Interaction with ADRs 0001–0003

### Layout extension

```
<cwd>/.claude/agnz/
├── workspace.json                 ← now contains `items[]`, `mode`, `reviewRequired`
├── workspace.json.lock            ← transient, held during mutations
├── messages.jsonl
├── cursors/
├── agents/
├── threads/
└── scratch/
```

No new top-level files. The board is a fat field on `workspace.json`.

### Messaging integration (ADR 0002)

- Messages can carry an `item_id`. A `handoff` message typically references an item.
- When agent B receives a handoff for item T, B's turn context includes T's full details (not just the message). This is the one place where the board and the mailbox cooperate.
- A sub-agent posting a `board_note` does not duplicate the note into `messages.jsonl`. Board notes and messages are different lanes: board notes are persistent item history, messages are ephemeral communication.

### Agent definitions (ADR 0003)

- Agent definitions may override `reviewRequired` per agent. The effective gate is the stricter of workspace and agent.
- A future field `boardColumns` on agent definitions could restrict which columns an agent may move items into (e.g. a junior researcher can only move items backlog → in_progress → review, never to `done` or `cancelled`). Deferred to a later ADR.

### Process lifecycle (ADR 0001)

- `agent_start` gains an implicit behaviour: when an agent is started with a task, the first thing the parent typically does is create a board item for the task and pass the item id in the initial message. This is convention, not enforcement — but we will document it as the intended flow.
