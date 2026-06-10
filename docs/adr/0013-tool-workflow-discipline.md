# ADR 0013: Tool workflow discipline — Grep before Read, Read before Write

- **Status:** Implemented
- **Date:** 2026-06-10
- **Branch:** `claude/observability-strategy-testing-AZMLM`
- **Depends on:** [ADR 0003](./0003-agent-definitions.md), [ADR 0011](./0011-observability-and-evaluation.md), [ADR 0012](./0012-context-management.md)

## Context

ADR 0012 keeps the sub-agent's context small through *machinery* (frozen system prefix, ingestion control at the tool boundary). This ADR addresses the other half: the **behaviour** of the agent — how it uses tools. The two are complementary; machinery bounds the worst case, behaviour keeps the common case lean.

Two failure modes are common, especially with smaller local models:

1. **Over-reading.** The model reads whole files blindly ("let me read everything") instead of locating the relevant spot first. A single large read can dominate — or exceed — the context window. This defeats the pull-not-push principle and bloats every subsequent request (the read result is re-sent every turn).

2. **Blind writing.** The model edits or overwrites a file it has not read in this thread, clobbering content it never understood, or producing an imprecise edit.

These are not bugs in the machinery — they are *discipline* problems. A clear, ordered tool workflow addresses both:

> **Grep before Read, Read before Write.**

Note the two halves have different motivations:
- **Grep → Read** is about **context efficiency** — locate with a targeted search, then read only the relevant slice.
- **Read → Write** is about **correctness/safety** — never mutate existing content you have not seen.

This difference drives how strict each half should be.

## Decision

This is **harness logic** — the deterministic control layer that keeps the model on the rails — not a feature the agent uses. It lives where the existing guardrails already live: the sandbox + the loop's tool-dispatch path. The model proposes tool calls; the harness validates, tracks, and corrects.

### The substrate: a per-thread knowledge state

The harness keeps private bookkeeping of the agent's knowledge: a per-thread set of **known files** — the absolute (sandbox-resolved) paths the agent has `Read`, `Write`, or `Edit`-ed in this thread. It is persisted on the thread meta (`knownFiles`), so it survives resumes and server restarts. This is internal harness state; it is not exposed to or steered by the agent.

### The mechanism: a reactive interceptor

In the tool-dispatch path, before a tool runs, the harness checks the call against the discipline. On a violation it **does not run the tool**; instead it injects a **corrective prompt** as the tool result, and the model re-decides on the next turn. This is stronger than static prompt text (weak local models ignore that) and softer than a hard error (it coaches rather than fails the thread). The interception is recorded in the ADR 0011 trace as a `tool_call` with `outcome: "blocked"`, so harness interventions are measurable.

A short reminder of the discipline is *also* placed in the system-prompt framing (`lib/prompts.mjs`) so a compliant model never triggers the interceptor in the first place — belt and suspenders.

### Rule 1 — Read → Write/Edit (hard interception)

**Never modify or overwrite an existing file not in the known set.** On a `Write`/`Edit` whose resolved target exists but is not known, the harness blocks it and returns: *read it first, then retry*. A correctness guarantee against blind clobbering.

Exception: **creating a brand-new file** (target does not exist) needs no prior Read and passes freely. The rule is "Read before mutating *existing* content," not "Read before every Write."

### Rule 2 — Grep → Read (size-gated soft interception)

**Redirect a full read of a large file toward locating/slicing.** On a `Read` with no `start_line`/`end_line` whose target exceeds a byte threshold, the harness blocks it and returns: *use Grep to locate, or Read a slice with start_line/end_line*.

The trigger is **file size, not "was it grep'd"**. We deliberately do not gate on grep-status: a single early Grep would whitelist every later Read (useless), and many files are legitimately read directly (a small known config). Size targets the actual harm — dumping a huge file into context — with far fewer false positives. Small files and explicit slices pass untouched.

### Summary

| Rule | Motivation | Trigger | On violation |
|---|---|---|---|
| Read → Write/Edit | correctness | existing target not in known set | block + "read it first" |
| Grep → Read | context efficiency | full read of a file over the size threshold | block + "grep or slice" |

## Why this is cache-safe

Both rules only ever make the agent append *smaller, more targeted* tool results. They never modify earlier messages, so they do not invalidate the prefix cache (per ADR 0012's append-only invariant). This is the behavioural complement to ADR 0012's ingestion control: same goal (smaller appends), reached by guiding the model rather than capping the tool.

## Relation to evaluation

Behavioural guidance is only as effective as the model's ability to follow it. Strong models comply; small local models may ignore the prompt and over-read anyway. This makes the discipline **measurable** and a useful eval signal (ADR 0011 §5): does a given profile actually Grep-then-slice, or dump whole files? Turn count, prompt-token growth, and tool-error rate in the trace reflect compliance. The enforcement question (§ above) matters most precisely for the models that *won't* self-comply.

## Implementation

- **State:** `knownFiles` on the thread meta (`lib/threads.mjs`), updated after every successful `Read`/`Write`/`Edit` in both tool-run paths (`runToolAndAppend` and the approval-resume path in `resolvePending`), keyed by `sandbox.resolvePath` so `x.txt`, `./x.txt`, and the absolute path collapse to one entry.
- **Interceptor:** `checkWorkflowDiscipline()` in `lib/loop.mjs`, called early in `dispatchToolCall` (before the permission decision, so a violating call never even reaches an approval pause). Returns a corrective string or `null`.
- **Trace:** a blocked call emits `tool_call` with `outcome: "blocked"`; `lib/trace-stats.mjs` counts it.
- **Prompt:** a one-line reminder of both rules in `SANDBOX_FRAMING` (`lib/prompts.mjs`).
- **Threshold:** the Grep→Read size gate is a named constant (`LARGE_READ_BYTES`), tunable.
- Covered by `tests/workflow-discipline.test.mjs`.

## What we are NOT doing

- **Not** mandating a Grep before every Read — small files and explicit slices pass.
- **Not** blocking new-file creation (no Read required to create).
- **Not** adding new tools — this is discipline over the existing Grep/Read/Write/Edit set.
- **Not** tracking line-range granularity yet — a file is "known" as a whole once read, even if only a slice was read.

## Deferred / open questions

- **Out-of-band knowledge.** The harness sees structured tool calls, not the model's mind. A file read via `Bash cat` is invisible to `knownFiles`, so a later `Write` to it would be (wrongly) blocked. Acceptable — the correction just tells the agent to `Read` it; and Bash is often restricted anyway.
- **Range granularity.** Tracking *which lines* were read would let "Write to an unread region" be caught precisely. Deferred; whole-file granularity is the V1.
- **Cross-agent staleness.** If another agent edits a file this agent read, this agent's knowledge is stale. Single-thread tracking does not detect that. Deferred to a multi-agent state design.
- **Threshold tuning.** `LARGE_READ_BYTES` is a guess; the right value depends on the model's context window. The ADR 0011 trace (`blocked` rate vs. prompt-token growth) is the feedback signal for tuning it.
