# ADR 0020 — One log per thread: every view is a projection

- **Status:** Accepted — implementation in progress. Phase 0 (additive diagnostics) shipped in 0.23.0; the unified log is the current work.
- **Date:** 2026-07-25
- **Relates to:** ADR 0011 (observability — this replaces its trace file), ADR 0012 (context management — the frozen prefix is what makes request logging cheap), ADR 0015 (lead context discipline — the lead still reads none of this), ADR 0019 (the lead dashboard — a consumer)

## Context

The trigger was a field incident: a run against the LAN inference box answered `EHOSTUNREACH`, and "what happened" turned out to be expensive to answer — the error reached the user and was written down **nowhere**. A search across every agnz workspace on the machine found zero occurrences, including in the append-only `messages.jsonl`.

The path was `agnz config test` (`bin/agnz.mjs:753`): it catches, calls `fail(err.message)`, prints to stderr and exits. The one command with server contact that a user runs *because the model is not answering* is the one command that logs nothing.

That is a symptom. The disease is that agnz records what happens in four places organised by **file kind** rather than by **event**:

| File | Holds | Problem |
|---|---|---|
| `<id>.jsonl` | the wire transcript | model-facing state, no timing, no errors |
| `<id>.trace.jsonl` | timing + outcomes | no content — you see *that* a tool ran, not what it returned |
| `<id>.meta.json` | status, pending, `error` | last error only; overwritten by the next run |
| `messages.jsonl` | inter-agent delivery | one line per agent error, message text only |

Answering "why did this run fail" means opening three of them and joining by timestamp. Nothing carries a run id, so even the join is approximate — and `thread_start` fires only on a thread's first-ever run, so the endpoint and invocation data recorded there describes the *first* run of a thread that may have been resumed a dozen times against a changed profile.

Bruce's framing, which this ADR adopts:

> am liebsten wäre mir ja ein langes protokoll in dem alle api aufrufe alle inhalte, der komplette chatverlauf, alle toolcalls und antworten (inkl. fehler wenn was nicht geklappt hat wie eine datei die nicht existiert etc) sowie alle serverantworten stehen. je nachdem wer die datei öffnet kann daraus die chat historie bauen oder die api logs.

## Decision

**One append-only log per thread. Every other view is a projection of it.**

`<cwd>/.claude/agnz/threads/<id>.log.jsonl` replaces `<id>.jsonl` and `<id>.trace.jsonl`.

### Envelope

Every entry: `{seq, ts, run, turn, type, ...}`

- `seq` — monotonic per thread. Ordering is explicit rather than implied by file position, so a reader survives a partial write and a merger can order across sources.
- `run` — the run id (§2). Every event belongs to exactly one run.
- `turn` — loop turn within the run, or `null` for events outside the loop.

### 1. Event types

| Type | Carries |
|---|---|
| `run_start` | pid, trigger (`start`/`send`/`approve`/`answer`), cwd, resolved profile (name, origin, model, endpoint), agent def, prompt ref (version, template digest), turn offset |
| `run_end` | reason, per-run totals |
| `message` | the wire truth: `role` (user/assistant/tool), `content`, `tool_calls`, `tool_call_id`. **This is the transcript.** |
| `api_request` | model, params, `prefix` (digest of the frozen system prompt), `messages: {fromSeq, toSeq}` — see §3 |
| `api_response` | latency, finishReason, usage, HTTP status |
| `api_error` | latency, endpoint, and the client's structured detail: kind (`network`/`timeout`/`http`/`bad_json`/`no_choices`), syscall code, HTTP status, response body |
| `tool_exec` | `refSeq` (the `message` holding the result), name, outcome (`ok`/`error`/`denied`/`blocked`/`deduped`), latency, target |
| `harness` | what the harness did on its own: workflow block, dedup, repetition nudge, compaction, arg repair, pause |

### 2. The run becomes a first-class entity

A run id (uuid, minted by the runner before it claims the thread) on every event. agnz's unit of execution has always been the run — one detached `runner.mjs` process advancing the loop one segment — but nothing named it. `thread_end` was in fact a *run* end; a thread with eight resumes emitted eight of them.

`run_start` records everything that can differ between runs of the same thread. This is what makes "the endpoint this run actually used" answerable, which phase 0 could not do.

### 3. Content is stored once — requests reference, they do not copy

The naive reading of "alle api aufrufe alle inhalte" is to log each request body in full. That is quadratic: the request *is* the whole conversation, so turn 40 rewrites everything turns 1–39 already wrote. A 40-turn run would spend tens of MB on one conversation held ~40 times.

Instead, `api_request` carries **no message content at all**. It names a range:

```json
{"seq": 118, "type": "api_request", "run": "…", "turn": 12,
 "model": "devstral-2:64k", "prefix": "a3f1c9d2",
 "messages": {"fromSeq": 4, "toSeq": 117},
 "params": {"temperature": 0.2, "maxTokens": 4096}}
```

Reconstruction is exact: take the `message` events in `[fromSeq, toSeq]`, prepend the system prompt named by `prefix` (`<id>.system.txt`, write-once), and you have the byte-identical request that went out. Nothing is lost, nothing is stored twice, and growth is linear.

This falls out of ADR 0012: the prefix is frozen precisely so it does not change per turn, and `fromSeq` naturally expresses compaction — after a `_compact` marker the loop sends from the marker on, so `fromSeq` points at it.

The same rule applies everywhere. `tool_exec` does not restate the tool's output; it references the `message` that holds it. **One fact, one place** is the whole point — restating it in a second event would recreate, inside one file, exactly the redundancy this ADR exists to remove.

### 4. What the projections are

- **Chat history** — `type:"message"`, in `seq` order. What `buildMessages` needs.
- **API log** — `api_request` + `api_response`/`api_error`, with §3 reconstruction for full bodies.
- **Tool log** — `tool_exec` joined to its `message` by `refSeq`.
- **Stats** — the existing `trace-stats` fold, over the same events.

### 5. What does not move

- **`meta.json`** stays: status, pending, card, runner pid. That is *state* — the current answer to "what is this thread doing" — not history. `error` shrinks to a pointer (`{run, seq}`) plus the one line `show` renders.
- **`<id>.system.txt`** stays: write-once, large, referenced by digest from every `api_request`.
- **`messages.jsonl`** stays: it is the inter-agent **delivery channel**, workspace-scoped and cross-thread. Not a per-thread record.
- **The lead still reads none of these** (ADR 0015). This is for the dashboard, for `show`, and for a human debugging a failure.

### 6. Events without a thread

`config test` — the incident path — has no thread to log to. Workspace-scoped events (server contact, config failures, preflight) go to `<cwd>/.claude/agnz/workspace.log.jsonl`, same envelope, `run`/`turn` null. Without this the failure that motivated the ADR would still go unrecorded.

### 7. Migration

Switch directly, per Bruce: "wir können auch per git zurück, insofern ruhig sofort switchen."

With one caveat that decision does not cover: **git reverts code, not data.** A revert would leave threads whose history exists only in a file the reverted code cannot read. So during the switch `<id>.jsonl` keeps being **written and never read** — a write-only shadow, a few lines, deleted once the log has proven itself. That is what makes the rollback real rather than notional.

`<id>.trace.jsonl` gets no shadow: it is pure observability, and losing it on a revert costs diagnosis, not correctness.

Old threads have no log. Readers fall back to the old pair when `<id>.log.jsonl` is absent, rather than rejecting them.

## Consequences

- A failure is answerable in one file, in order, without timestamp arithmetic across three.
- The log is **correctness-critical** once the transcript is a projection of it: a bug in `projectMessages` breaks running threads, where before it would only have broken a report. This is the real cost of the decision and the reason for the shadow write.
- OpenTelemetry mapping (ADR 0011 §6) gets easier, not harder: a run is a span, `run` is its id, `api_*` and `tool_exec` are child spans.
- Retention becomes a real question. Nothing prunes these files, and this one holds content. Out of scope here — but it stops being ignorable now that a single file holds everything.

## Open

1. **Redaction.** Requests are logged, so the apiKey must never enter one. Today it is safe only because requests are not logged at all. Needs an explicit deny-list and a test, not care.
2. **Dashboard adapter.** `TraceAnalysisAdapter` reads `<id>.trace.jsonl`. It needs the projection instead. That is the dashboard project's work, and this ADR is its spec.
3. **Size caps on tool results.** A 512 KiB Read result currently lands in the transcript verbatim and now lands in the log verbatim. Same bytes as today, but now they are also the diagnostic record — capping them costs fidelity where it was previously free.
