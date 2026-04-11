# ADR 0010: Workspace file manager — open/close files as context state

- **Status:** Proposed / Deferred
- **Date:** 2026-04-10
- **Updated:** 2026-04-11
- **Depends on:** [ADR 0001](./0001-workspace-first-architecture.md), [ADR 0003](./0003-agent-definitions.md)
- **Supersedes:** rolling-compression approach from `lib/compression.mjs` (retained as fallback, not the primary strategy)

> **2026-04-11 — Deferral note:** Implementation of this ADR is deferred. The goal remains
> reducing context bloat from file reads, but we do not yet have a reproducible evaluation
> framework to compare different approaches. See §6 for the deferred decision and open
> evaluation questions.

## Context

When a sub-agent works on a multi-file task, the transcript grows with each file read:
every `Read` call stores the full file content as a tool result in the persisted history.
By turn 10 of a realistic coding task, the transcript may contain 20–30k tokens of raw
file content — content that is stale the moment the file is edited, and that the model
must skip over to reach the recent reasoning.

Rolling compression (ADR 0008 Tier 1 draft) addresses this as a heuristic after the fact.
This ADR addresses it structurally: **file content never enters the transcript at all**.
Instead it lives in a managed "open files" state that is always current, always compact,
and injected fresh at each turn by `buildMessages()`.

The analogy is an IDE: the agent has an open-files workspace. It opens files it needs,
edits them in place, and closes them when done. The framework keeps the content current;
the agent only sees the latest version.

## Decision

### 1. Open-files state in thread meta

A new field `openFiles` is added to the thread meta JSON:

```json
{
  "openFiles": {
    "lib/loop.mjs":        { "content": "...", "openedAt": 7, "lastAccessAt": 12 },
    "lib/compression.mjs": { "content": "...", "openedAt": 9, "lastAccessAt": 9  }
  }
}
```

- `openedAt` / `lastAccessAt` — turn counters for LRU eviction (see §4)
- `content` — the current on-disk content at the time of last read or edit

### 2. Tool changes

Three tools participate. The agent's API is unchanged — it still calls `Read`, `Edit`, and
a new `Close`. The difference is what happens inside:

**`Read(path)`**

1. Read file from disk (as today).
2. Store content in `openFiles[path]`.
3. Return a short acknowledgement as the tool result instead of the full content:
   `"[lib/loop.mjs opened — content injected into context]"`

The file content reaches the model via the injected block in `buildMessages()`, not via
the tool result. This prevents the content from appearing twice and keeps the transcript
small.

**`Edit(path, old_string, new_string)`**

1. Perform the edit (as today).
2. Re-read the file from disk.
3. Update `openFiles[path].content` with the new content.
4. Return the existing short result (`"ok"` or error).

The agent does not need to call `Read` again after an edit to get the updated view — the
injected block is already current on the next turn.

**`Close(path)` — new tool**

```
args: { path: string }
```

Remove `path` from `openFiles`. The agent calls this when it is done with a file and
wants to free working memory. Tool result: `"[lib/loop.mjs closed]"`.

Policy: `Close: allow` (no approval needed).

**`Write(path, content)`** — same as `Edit`: after writing, update `openFiles[path]` if
the path is already open, or add it if not.

### 3. buildMessages() injection

At the start of each turn, `buildMessages()` injects two things:

**a. Workspace stats line in the system prompt:**

```
Open files: 3 files, ~15 200 tokens (62% of working memory)
```

When usage exceeds 80%:

```
Open files: 4 files, ~19 800 tokens (81% of working memory)
⚠  Working memory is nearly full. Close files you no longer need before opening new ones.
```

The token budget is derived from the profile's `maxTokens` if set, otherwise a
configurable default (e.g. 40 000 tokens). Estimate: 1 token ≈ 4 characters.

**b. Open-files content block, injected as a synthetic `user` message immediately before
the persisted history:**

```
[workspace — open files]

--- lib/loop.mjs (320 lines) ---
<content>

--- lib/compression.mjs (85 lines) ---
<content>
```

This synthetic message is never appended to the transcript — it is built fresh each turn
from the current `openFiles` state. Edits are therefore always reflected on the next turn
without any explicit re-read.

### 4. LRU eviction (safety valve)

If the number of open files exceeds a limit (default: 10 files or 50% of `maxTokens`,
whichever is hit first), the framework automatically closes the least-recently-accessed
file before opening a new one. The eviction is noted in the transcript:

```
[workspace] lib/old-file.mjs auto-closed (LRU — working memory limit reached)
```

This prevents runaway context growth when the agent ignores the >80% warning.

### 5. Backwards compatibility

- Threads that pre-date this ADR have no `openFiles` field — `buildMessages()` treats
  a missing or empty field as "no open files" and injects nothing extra.
- The `Close` tool is additive; existing agent defs that do not list it still get the
  default-allow policy via `defaultPolicy`.
- `compression.mjs` remains as a fallback for threads that do not use the workspace model
  (e.g. old threads resumed after upgrade). It is not the primary strategy.

## Files affected

| File | Change |
|---|---|
| `lib/tools/Read.mjs` | After read: store content in `openFiles`, return short ack |
| `lib/tools/Edit.mjs` | After edit: re-read file, update `openFiles` |
| `lib/tools/Write.mjs` | After write: update/add `openFiles` |
| `lib/tools/Close.mjs` | New. Remove path from `openFiles` |
| `lib/tools/registry.mjs` | Register `Close` |
| `lib/sandbox.mjs` | Add `Close: allow` to `defaultPolicy` |
| `lib/loop.mjs` | `buildMessages()`: inject stats + open-files block; pass turn counter to tools |
| `lib/threads.mjs` | `openFiles` field in thread meta schema |
| `CLAUDE.md` | Module map entry for `Close.mjs`, note on workspace model |

## What we are NOT building in this ADR

- **Diff-based updates.** The injected content is always the full current file, not a
  patch. Diffs would save tokens for large files with small changes but add complexity.
- **Cross-thread open-files persistence.** The `openFiles` state is per-thread. A new
  thread starts with an empty workspace (the brain system, ADR 0008, handles cross-thread
  knowledge).
- **Explicit workspace UI for the parent.** The parent can read `openFiles` from the
  thread meta JSON directly. A `/agnz:workspace` display command is deferred.

## Deferred / Open questions

- **Token budget source.** `maxTokens` in the profile is the output limit, not the
  context window. We need a separate `contextTokens` profile field (or a per-model
  default table) to compute the working-memory percentage accurately.
- **Binary / large files.** Files over a configurable size threshold (e.g. 100 KB)
  should not be auto-opened into working memory. Read falls back to the current behaviour
  (content in tool result, not in openFiles) for oversized files.
- **Skill content.** Skills loaded via `Skill({action:"load"})` are also large injected
  blobs. Should they count against the working-memory budget and be closeable? Deferred.

## §6 — Deferred implementation

This ADR describes one concrete approach (per-file workspace with synthetic message injection).
The problem it solves — context bloat from file reads in long sub-agent runs — is real, but
we do not yet have a systematic evaluation framework to compare this approach against
alternatives.

**Decision: no compression implementation until evaluation framework exists.**

Before committing to any single strategy, we need a reproducible test setup that can measure:
- transcript size over N turns for a given task
- model output quality (factual accuracy, coherence)
- latency and token cost

**Candidate strategies to evaluate:**

1. **Workspace model (this ADR)** — file content in synthetic messages, always current,
   per-file close control. Pro: structural fix, no lossy compression. Con: still injects
   full file content; large files remain large.

2. **LLM-based distillation** — summarise or extract key facts from file content before
   injecting. Pro: aggressive token reduction. Con: lossy; summarisation quality varies;
   extra LLM call per turn.

3. **Memory-tier integration (ADR 0008 Tier 2/3)** — offload stale file content to
   persistent brain storage, retrieve on demand. Pro: structural memory management. Con:
   requires brain system to exist first.

4. **Token budget with graceful degradation** — hard cap on injected file content,
   truncate or drop least-recently-read files. Pro: simple, predictable. Con: may lose
   context the model still needs.

5. **Provider-side context window** — delegate compression to the LLM provider (if supported).
   Pro: zero implementation effort. Con: not universally available; behaviour unpredictable.

**Evaluation setup needed:**

- A reproducible multi-file task (e.g. "add feature X to project Y") that can be run against
  multiple model endpoints with consistent prompts.
- Metrics: transcript token count per turn, final output quality scored manually or via a
  judge model.
- Baseline: current behaviour (full file content in tool results) as reference point.

This ADR remains as a living design document. When an evaluation system exists, the
decision will be revisited and the winning strategy will be implemented.
