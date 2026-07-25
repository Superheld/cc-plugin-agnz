# ADR 0020 — Diagnostics: one record per run, instead of four partial ones

- **Status:** Proposed — discussion draft. Phase 0 (additive, non-breaking) already shipped in `5be7622`; everything below the line marked *breaking* is the open question.
- **Date:** 2026-07-25
- **Relates to:** ADR 0011 (observability — this revisits its trace schema), ADR 0015 (lead context discipline — why the lead must not read raw files), ADR 0017 (config and state consolidation — the precedent for a breaking consolidation), ADR 0019 (the lead dashboard — the consumer)

## Context

The trigger was a field incident: a run against the LAN inference box died with `EHOSTUNREACH`, and the question "what happened" turned out to be surprisingly expensive to answer.

### What one failure leaves behind today

The same error is written to three files, in three shapes:

| File | Shape | Survives |
|---|---|---|
| `<id>.meta.json` | `error: {message, stack}` | message + stack, overwritten by the next run |
| `messages.jsonl` | `"[<id>] Agent error: <message>"`, urgent, to parent | message only, append-only |
| `<id>.trace.jsonl` | `thread_end reason:"error" error:"<message>"` | message only, append-only |

Three records, no shared identifier beyond the thread id, no agreement on shape, and the union of them still omits most of what a diagnosis needs. That was the observation behind Bruce's "das geht sicherlich aufgeräumter und muss nicht über so viele Dateien teils redundant verteilt werden".

### What phase 0 already fixed (shipped, additive)

`5be7622` closed the worst of the *missing* data without touching any existing field:

- `llm_call` is written on failure too (`outcome: "error"`), carrying the latency spent before failing, the endpoint, and structured detail from the client (`kind`, `url`, syscall `code`, HTTP `status`, up to 2 KiB of the server's body). Before this the trace went `turn_start` → *nothing* → `thread_end`: neither the duration nor the address survived.
- `thread_start` records `endpoint` and an `invocation` block (cwd, profile + config layer, agent def, prompt stamp).
- The consumers were adjusted so the new events do not degrade what they measure (`trace-stats` counts `llmErrors` separately; `status.mjs` clears the in-flight marker on an error but keeps its latency out of the hung-threshold median).

That is the cheap half. It does not address redundancy, and it exposed a structural problem it cannot fix from inside.

### The structural problem: there is no run

agnz's unit of execution is the **run** — one detached `lib/runner.mjs` process advancing the loop one segment, spawned per `start`/`send`/`approve`/`answer`. A thread has many runs over its life.

The trace has no concept of it:

- There is no run id. Nothing in `lib/trace.mjs` or the event set (`thread_start`, `turn_start`, `llm_call`, `tool_call`, `repair`, `pause`, `compaction`, `thread_end`) identifies which run an event belongs to.
- `thread_end` is misnamed: it fires at the end of every **run**, not at the end of the thread. A thread with eight resumes has eight `thread_end` events.
- `thread_start` fires only on a thread's first-ever run (`firstEverRun && turn === 0`). Everything it carries is therefore recorded **once, for the first run only** — including the `endpoint` and `invocation` block phase 0 just added. Change a profile mapping and resume, and the trace still names the old endpoint. The freshly-added diagnostic is accurate exactly until the first thing worth diagnosing changes.
- The runner's pid is on the meta, transiently, and nowhere in the trace. After the fact you cannot tell which OS process produced which events.

So "what happened in the run that failed" cannot be asked. Only "what happened in this thread, ever" can, and the answer has to be re-segmented by hand at each `thread_end`.

This is also why the redundancy is hard to remove by simply deleting two of the three records: they are not redundant *copies*, they are three different scopes (thread state / delivery to the lead / event history) that happen to overlap on one string. Collapsing them needs the missing scope — the run — to exist first.

## Decision (proposed)

### 1. The run becomes a first-class entity — *non-breaking*

Introduce a run id (uuid, minted by the runner before it claims the thread) and two events:

- `run_start` — run id, pid, trigger (`start`/`send`/`approve`/`answer`), cwd, resolved profile + origin, endpoint, model, agent def, prompt stamp, turn offset. Everything `thread_start` carries today that can change between runs, recorded **every** run.
- `run_end` — run id, reason, per-run totals. Replaces `thread_end` in meaning.

`thread_start` keeps its first-run-only role for what is genuinely thread-scoped and immutable (the frozen system prompt, the tool list). Every event gains a `run` field.

`thread_end` stays emitted, unchanged, for one release so the dashboard adapter keeps working, then goes. That deprecation window is the only reason this item is separable from the breaking part.

**Open:** whether `run` on every event is worth its bytes versus deriving membership from ordering between `run_start`/`run_end`. Ordering is sufficient for a well-formed file; the explicit field survives a truncated or interleaved one. Leaning explicit — these files are appended by concurrent processes.

### 2. One error record, three views — *breaking*

The error becomes a trace event (`error`, carrying the run id and the structured detail phase 0 introduced), and the other two stop being independent records:

- `meta.error` shrinks to a pointer: `{runId, at}` plus the one-line message that `show` needs to render. It is state ("this thread is broken, here is the handle"), not history.
- The `messages.jsonl` entry stays — it is the **delivery channel** to the lead, not a record — but references the run id instead of restating the error.

This is the part that breaks the dashboard's `TraceAnalysisAdapter` and anything else reading `meta.error.stack`.

**Counter-model worth taking seriously:** leave all three, and add only the run id to each so they can be joined. Cheaper, no breakage, and the redundancy costs bytes rather than correctness. The argument against is that three writers of one fact drift — we already have the shapes disagreeing — but "drift" has not actually cost us anything yet, whereas a breaking change costs a day of dashboard work immediately. This should not be decided on tidiness.

### 3. What does *not* change

- **File-per-kind stays.** The transcript (`<id>.jsonl`), the trace (`<id>.trace.jsonl`) and the frozen prompt (`<id>.system.txt`) have different lifetimes, different write patterns and different readers. Merging them into one file would trade a clear boundary for a smaller `ls`. "Fewer files" is not the goal; "one place per fact" is.
- **The lead still does not read any of them.** ADR 0015's fence holds. This ADR is about what the *dashboard* and a human debugging a failure can reconstruct, not about what enters the lead's context.
- **OpenTelemetry-mappability** (ADR 0011 §6) stays a design constraint. A run maps to a span; `run` is a parent span id in all but name. Getting this right now is most of the work an exporter would otherwise need later.

## Consequences

- A failure becomes answerable in one query: *give me every event with this run id*. Today that is a manual re-segmentation of the thread's history.
- The `endpoint`/`invocation` data phase 0 added stops being first-run-only, which is the difference between a diagnostic that is usually right and one that is right when it matters.
- `trace-stats` can report per run rather than per thread, which is what "why was this resume slow" needs.
- Cost: a schema migration for the dashboard, and old traces that have no run id. Old traces should degrade to one implicit run rather than being rejected.

## Open questions

1. **Breaking or joined?** §2 versus its counter-model. This is Bruce's call and should be made on whether the dashboard work is wanted now, not on how the file layout reads.
2. **Does the transcript need the run id too?** It would let "which resume produced this message" be answered without timestamp arithmetic. Cheap, but it changes the message shape that `buildMessages` round-trips — needs checking that a stray field cannot reach the wire.
3. **Retention.** Nothing prunes trace files. A long-lived thread's trace grows without bound, and this ADR adds events. Out of scope here, but it stops being ignorable once runs are individually addressable.
