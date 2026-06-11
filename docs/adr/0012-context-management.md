# ADR 0012: Context management — stop the sub-agent prompt from growing every turn

- **Status:** Phase 1 implemented; phases 2–3 proposed
- **Date:** 2026-06-10
- **Branch:** `claude/observability-strategy-testing-AZMLM`
- **Depends on:** [ADR 0003](./0003-agent-definitions.md), [ADR 0005](./0005-skills-for-agents.md), [ADR 0011](./0011-observability-and-evaluation.md)

## Context

A sub-agent's memory/compute on the local inference server climbs steadily during ordinary task execution — even with no reasoning and on mechanical work — as if something is continuously being appended during inference. It is. The agent loop has **no context management**: `buildMessages()` (`lib/loop.mjs`) rebuilds the entire message array on every turn and re-sends it in full, and parts of it *grow* turn over turn.

### What we inject, and when

`buildMessages()` runs once per turn and emits, in order:

| Block | Size | Per-turn behaviour |
|---|---|---|
| `SANDBOX_FRAMING` | ~2 KB | static |
| **CLAUDE.md** (cwd + every *visited* subdir) | variable | **grows monotonically** |
| tool-restrictions note | ~0.1 KB | static |
| skill catalog | ~stable | **re-read from disk every turn** |
| agent body | static | static |
| `tools[]` schema | ~5 KB | sent in full every turn |
| **full transcript history** | unbounded | **grows monotonically** |

Tool results are large by design and stay in history verbatim forever: `Read` up to 512 KiB (`lib/tools/Read.mjs` `MAX_BYTES`), `Bash` up to 1 MiB (`lib/tools/Bash.mjs`), `Grep` up to 500 lines. A single `Read` in turn 3 is re-sent unchanged in turns 4, 5, 6, … until the thread ends.

### Why this hurts more than "history just grows"

Two amplifiers turn linear history growth into something worse:

1. **The system prompt itself grows.** `visitedDirs` (`lib/loop.mjs:682`) only ever accumulates within a thread; every directory touched by `Read`/`Edit`/`Write` is remembered, and `collectClaudeMds` injects the CLAUDE.md of **every** visited directory into the system prompt on **every** subsequent turn. A task that walks 15 directories drags 15 CLAUDE.md files in the system prompt for the rest of the thread.

2. **Prefix caching is defeated.** Because the system prompt differs every turn, the inference server (LM Studio / Ollama / llama.cpp) cannot reuse its KV cache from the system prompt onward — it reprocesses the whole prefix each turn. That is the "permanent growth" feeling: cost in both memory and compute climbs even on stumpfe Tasks.

3. **Disk I/O per turn.** The skill catalog and all CLAUDE.md files are re-read from disk on every `buildMessages` call (`lib/loop.mjs:410,425`), not just once.

The ADR 0011 trace makes this measurable: `llm_call.usage.prompt` per turn shows the monotonic climb directly — the before/after metric for any fix here.

## Decision

Phase the fix. **Phase 1 (this ADR's primary, chosen first) is to make the system prompt a stable prefix.** Phases 2–3 are documented here as the authoritative plan and implemented in follow-up commits.

### Phase 1 — Stable system-prompt prefix (chosen)

The system prompt must be **byte-identical from turn 0 to the end of the thread**, so the inference server can cache it and it stops growing.

- **Build the system prompt once, on the first run, and persist it** (e.g. snapshot onto thread meta or compute deterministically from inputs that do not change mid-thread). Subsequent turns reuse the snapshot verbatim instead of recomputing.
- **CLAUDE.md and the skill catalog are part of that one-time prefix.** They are read from disk once (turn 0), not every turn.
- **Visited-subdirectory CLAUDE.md no longer goes into the system prompt.** When the agent first touches a subdirectory that has a CLAUDE.md, inject that file **once** as a single synthetic `user`/tool-style message at that point in the transcript (it then lives in history like any other content, sent once and cached as part of the growing-but-append-only suffix), rather than re-templating the system prompt every turn. `visitedDirs` becomes a "already-injected" set, not a "re-inject-everything-each-turn" set.

Net effect: the system prefix is fixed; only the transcript suffix appends. That restores prefix-cache reuse and removes the system-prompt growth entirely.

> **Implemented (2026-06-10).** `renderSystemPrompt({thread, profile, registry, pluginRoot})` produces the prefix; `runThread` calls it once when `thread.systemPromptSnapshot` is absent and persists the result, and `buildMessages` reuses the snapshot verbatim. Visited-subdir CLAUDE.md no longer reaches the system prompt: file tools queue newly-seen subdirs in `pendingDirMds`, and `drainTopOfTurnContext` injects each subdir's CLAUDE.md once into history — merged into the same single user message as the mailbox drain so two consecutive user turns never occur. Covered by `tests/context-prefix.test.mjs` (byte-stable prefix across turns, subdir CLAUDE.md injected exactly once, snapshot persisted). Snapshot state is in `thread` meta (survives restarts); `pendingDirMds`/`visitedDirs` are in-memory, so a server restart mid-thread may re-inject a subdir CLAUDE.md once more — harmless.

### Phase 2 — Tool-result compaction in re-sent history

Old, large tool results do not need to be re-sent verbatim every turn once they have been consumed. On re-send, old results beyond a recency/size budget are replaced with a short excerpt plus a pointer (`[full result of <tool> in transcript <thread>.jsonl, N bytes]`). The full result always remains on disk in the transcript; only what is *re-sent to the model* is trimmed. The most recent K tool results are kept verbatim so the model's working set is intact.

### Phase 3 — Context budget / sliding window

When the assembled prompt exceeds a configurable token budget (profile- or agent-def-level), summarise or drop the oldest turns while always keeping the stable system prefix + the most recent N turns. This is the general backstop for long-running threads; phases 1–2 reduce how often it triggers.

## What we are NOT building

- **Semantic/embedding-based context selection.** Recency + size heuristics only; no vector store (zero-dep rule).
- **Provider-specific cache-control headers.** We make the prefix stable so *any* server's built-in prefix caching can engage; we do not special-case one vendor's API.
- **Changing the tool output caps.** `Read`/`Bash`/`Grep` caps stay; the fix is in what we *re-send*, not what a tool may return once.
- **Touching parent context.** The hooks (ADR 0007 / ADR 0011 §3) are a separate channel; this ADR is only about the sub-agent loop.

## Deferred / open questions

- **Snapshot vs. recompute for the stable prefix.** Persisting the rendered system prompt on thread meta is simplest and guarantees byte-stability across server restarts, but duplicates content already on disk. Recomputing deterministically avoids duplication but must guarantee identical bytes (CLAUDE.md edited mid-thread would change it). Leaning toward snapshot-on-first-run for correctness.
- **Mid-thread CLAUDE.md edits.** With a frozen prefix, edits to the cwd CLAUDE.md during a thread are intentionally ignored until a new thread. Acceptable; document it.
- **Summarisation model for phase 3.** Summarising old turns needs an LLM call — use the same local profile, or a cheaper one? Deferred to phase 3.
- **Interaction with the mailbox.** Mailbox drains append synthetic user messages (`lib/loop.mjs:382`); they are part of the append-only suffix and fall under phase 2/3 budgeting like any other history.
