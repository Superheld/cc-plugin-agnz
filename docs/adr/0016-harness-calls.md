# ADR 0016: Harness calls — the local model as infrastructure service

- **Status:** Proposed — deferred pending dogfooding
- **Date:** 2026-07-20
- **Depends on:** [ADR 0011](./0011-observability-and-evaluation.md), [ADR 0014](./0014-cli-replaces-mcp.md), [ADR 0015](./0015-lead-context-discipline.md)

## Context

Today the locally-hosted LLM behind agnz is used exactly one way: as an *agent*
— a task loop with tools, driven by a user-visible thread. But the same
endpoint could also serve *harness services*: small, tool-less, one-shot calls
that improve agnz's own infrastructure rather than doing agent work. Claude
Code itself sets a precedent — it uses a small model for compaction and
summarization, work that is infrastructure for the session rather than the
session's actual task.

The economics line up unusually well for agnz specifically:

- **Local tokens are free.** A harness call costs nothing against the
  Anthropic budget the plugin exists to protect.
- **Nobody waits.** The detached-runner model (ADR 0014) means a harness call
  at segment end does not block the lead — it can run after the runner process
  would otherwise have exited.
- **The endpoint is guaranteed warm.** The segment that just ran used the same
  LM Studio/Ollama endpoint, so there's no cold-start cost to a follow-up call.

**First candidate: the rolling thread summary.** `summarize()` in `lib/loop.mjs`
today is a fixed heuristic (first line of the last answer, truncated to 140
chars), which produces fragments like "Deleted thread IDs: 92ba…" — accurate
but not a mission/state summary. A harness call could instead produce a
genuine "mission → current state" one-liner for the ADR 0007 workspace block.

## Decision (sketch, not yet implemented)

This ADR records the design so it is ready to pick up, but implementation is
**deferred**. Two reasons:

1. **The cheap alternative is largely untested.** A mechanical resume-card —
   task line from the thread's first user message + the existing heuristic
   summary + `ctxTokens` from the last `llm_call.usage.prompt` — likely
   captures most of the value at zero additional calls. That should be
   dogfooded first; a harness call is only worth its complexity if the
   mechanical version is measurably insufficient.
2. **Real latency risk.** Local inference servers (LM Studio in particular)
   serialize requests. A summary call fired at segment end queues *ahead of*
   the next segment's first call during rapid lead↔agent ping-pong —
   precisely the moment where added latency hurts most. This needs to be
   validated against a live server before it ships, not assumed away.

### Design sketch for when it is picked up

- A small **detached summarizer process**, spawned at segment end with a
  delay (roughly 60–120 s) that first re-checks the thread is still `idle`
  and aborts if not — a debounce so summaries never fire mid-work and never
  contend with the next segment's first call.
- **Fallback to the existing heuristic** whenever the call fails outright or
  its output fails a plausibility check (length bounds, expected format) —
  the summary must never be allowed to go missing or garbled because of this.
- **Trace tagging.** Every harness call is tagged in the ADR 0011 trace —
  `llm_call` gains a `purpose` field, `"summary"` for harness calls,
  implicitly `"agent"` for ordinary agent turns — so spend accounting and the
  eval harness can separate harness overhead from agent work.
- **Model resolution through one seam.** Harness calls resolve their model the
  same way agent calls do today, so a later `"_utility"` entry in
  `modelProfileMappings` can route harness calls to a smaller/faster model
  without touching the call sites.
- **Never surfaces to the lead directly.** A harness call produces no
  `messages.jsonl` entry and no hook output of its own — only its *product*
  (a better summary line in the workspace block) reaches the lead. This keeps
  the lead-side context discipline of ADR 0015 intact: harness calls are pure
  infrastructure, invisible by construction, not one more thing competing for
  the lead's attention.

## Consequences (if/when implemented)

- A new class of LLM call exists alongside agent turns, with its own trace
  semantics (`purpose` field) — `trace-stats.mjs` (ADR 0011 §2) needs to
  aggregate the two separately so harness overhead doesn't get counted as
  agent spend.
- Adds a second process-spawn path (the delayed summarizer) alongside the
  runner, with its own debounce/idle-check logic to get right — a source of
  bugs if the idle-recheck is skipped or racy.
- Opens the door to further harness-call candidates beyond summaries (e.g.
  compacting large tool results per ADR 0012 phase 2) once the pattern is
  proven — not scoped here.

## Why deferred, not rejected

Nothing here is wrong on paper — the economics genuinely favor it. It is
deferred because the cheaper mechanical alternative hasn't been tried yet, and
because the failure mode of getting it wrong (a summary call queueing ahead of
real agent work on a serialized local server) is exactly the kind of thing
that looks fine in design and only shows up under load. Pick this up after
the resume-card has been dogfooded and found wanting.
