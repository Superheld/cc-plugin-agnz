# ADR 0008: Brain system — three-tier memory for agents

- **Status:** Proposed (roadmap)
- **Date:** 2026-04-09
- **Depends on:** [ADR 0001](./0001-workspace-first-architecture.md), [ADR 0003](./0003-agent-definitions.md)

## Context

A sub-agent thread has no memory of previous threads. Every run starts from scratch. The agent rediscovers file locations, re-reads the same modules, rebuilds the same mental model of the codebase. For a single short task this is fine. For a team of agents working on a project over days, it is wasteful — and it means knowledge that was hard-won (the auth module works this way, that API is deprecated) has to be re-learned every time.

What agents need is a memory system with the right lifetime for each kind of knowledge:

- **Short-term:** what is in context right now — the thread transcript, injected messages, file reads. Volatile, gone when the thread ends.
- **Mid-term (recognition):** what matters enough to survive context compression, but not necessarily forever. Tied to the session and the ongoing work.
- **Long-term:** what the agent or the team has learned that should persist across sessions and threads.

These three tiers require different storage mechanisms and different access patterns.

## Decision

### Tier 1 — Short-term: the active context

Short-term memory is everything currently in the agent's context window:

- The thread transcript (conversation history)
- Messages drained from the inbox (ADR 0002)
- File content read during the run
- Skill content loaded via `use_skill`
- Brain entries injected at thread start (from Tier 3)

No new mechanism is needed here. The loop already manages this. The design challenge is not *adding* to short-term memory but *curating* it — keeping the context lean by not loading things the agent does not need. Skills (ADR 0005) and selective brain injection (see Tier 3) are the tools for that.

### Tier 2 — Mid-term: recognition across context compression

When Claude Code compresses the parent's conversation, content is summarised or dropped. For the sub-agent, context compression is not a CC feature — it is something we must implement ourselves if we want it: as the transcript grows, older turns may push newer content out of the model's effective context.

Mid-term memory is the answer: **at the end of a thread, or when the transcript exceeds a threshold, distil key findings into a compact, structured note.** This note is not the transcript — it is a synthesis: what was discovered, what decisions were made, what the agent recommends next.

The distillation is done by the agent itself (via a final `brain_write` before it closes), or triggered automatically by the loop when a `maxTurns` limit is approaching. The note lands in the workspace brain (Tier 3) tagged as a `session-summary` entry.

The parent Claude's mid-term memory is handled by CC's own auto-memory system. We rely on the parent to record important outcomes from agent interactions into its own memory. agnz's mid-term is per-agent and per-workspace, not per-parent-session.

### Tier 3 — Long-term: the workspace brain

Long-term memory is a per-workspace, per-role knowledge store: named entries that survive across threads and sessions.

**Storage layout:**

```
<cwd>/.claude/agnz/brain/
├── _shared.md         ← readable and writable by all agents in the workspace
├── researcher.md      ← private to the researcher role
└── editor.md          ← private to the editor role
```

Plain markdown. Human-readable, diffable, editable. Each entry is a named section:

```markdown
## auth-session-location
_by researcher · 2026-04-07_

Session token in `lib/auth/session.mjs:47`. Signed JWT, 7-day expiry.
Middleware: `lib/middleware/auth.mjs:requireAuth`.
```

**Access tools:**

```
brain_read({ query: "auth session" })      → keyword search across entries
brain_read({ entry: "auth-session-location" })  → exact lookup
brain_write({ entry: "...", content: "...", scope: "shared" | "role" })
brain_list()                               → all entry headings + first line
```

Policy: `brain_read: allow`, `brain_write: ask` (persist=true to unlock for the thread).

**Brain injection at thread start:**

The system prompt includes entries flagged as `pinned: true` automatically. Non-pinned entries are loaded on demand via `brain_read`. This keeps the system prompt lean while ensuring critical architectural facts (team agreements, known gotchas) are always visible.

**Brain vs. transcript:**

The transcript is a record of *what happened*. The brain is a record of *what was learned*. The transcript grows indefinitely; brain entries are curated and updated. When a finding in the transcript is important enough to persist, the agent writes it to the brain explicitly.

**Brain vs. skills:**

Skills (ADR 0005) are stable how-to instructions authored by humans. Brain entries are dynamic facts discovered during runs. A brain entry that stabilises into a convention can be promoted to a skill by hand.

### The role of the parent Claude

The parent can read the brain directly (it is plain files under `.claude/agnz/brain/`). A future `/agnz:brain` slash command would pretty-print the current entries. The parent can also write entries (to record instructions or agreements that sub-agents should know) without going through an agent — useful for pre-seeding a new workspace with known project context.

## What we are NOT building in this ADR

- **Embeddings / vector search.** Keyword matching in V1. No deps.
- **Cross-workspace brain.** Per-workspace only. A user-wide "global brain" that survives across projects is deferred.
- **Automatic brain population.** Agents write to the brain explicitly. No automatic extraction from transcripts.
- **CC auto-memory integration.** The parent's auto-memory (the system running this very project's memories) is separate from the agent brain. Bridging them — e.g. having the parent write agent-discovered facts into its own memory — is a workflow the user can do manually. Automation belongs in a follow-up.

## Deferred / Open questions

- **Conflict resolution.** Two agents writing the same entry concurrently: last write wins in V1. A proper lock or CRDT for concurrent writes is deferred.
- **Pruning and expiry.** A `ttl:` field on entries, or a `/agnz:brain prune` command. Without this the brain grows without bound.
- **Fuzzy/semantic search.** When keyword matching misses entries due to terminology drift. A middle ground (trigram similarity, local embedding model) before committing to a full vector store.
