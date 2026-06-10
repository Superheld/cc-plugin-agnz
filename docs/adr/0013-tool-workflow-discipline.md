# ADR 0013: Tool workflow discipline — Grep before Read, Read before Write

- **Status:** Proposed
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

Encode the workflow discipline in the sub-agent **harness** (the system-prompt framing in `lib/prompts.mjs`), and treat the two halves differently:

### 1. Grep → Read (guidance)

The harness instructs the agent: to find something in an unfamiliar or large file, **Grep first** to locate it, then **Read the relevant slice** (`start_line`/`end_line`) rather than the whole file. Searching is half of reading; a Grep with context often removes the need to Read at all.

This is **guidance, not a hard rule.** Reading a small, known file directly is perfectly fine — forcing a Grep before every Read would be wrong. It is a default bias toward targeted reading, enforced softly through the prompt.

### 2. Read → Write/Edit (candidate for enforcement)

The harness states: **never modify or overwrite an existing file you have not read in this thread.** Unlike the Grep rule, this is close to absolute and is a correctness guarantee, so it is a candidate for **hard enforcement** in the harness (precedent: Claude Code refuses an Edit to a file not previously Read).

Exception: **creating a brand-new file** needs no prior Read (there is nothing to read). The rule is "Read before mutating *existing* content," not "Read before every Write."

### Guidance vs. enforcement

| Rule | Motivation | Strictness | Mechanism |
|---|---|---|---|
| Grep → Read | context efficiency | soft default | system-prompt guidance |
| Read → Write/Edit (existing file) | correctness/safety | near-absolute | guidance now; hard check candidate |

A hard Read-before-Edit check would track which files were read in the thread and reject an Edit/overwrite to an unread one. That is feasible (the loop already tracks touched directories) but is an implementation choice deferred to its own change — this ADR fixes the *policy*, not the enforcement code.

## Why this is cache-safe

Both rules only ever make the agent append *smaller, more targeted* tool results. They never modify earlier messages, so they do not invalidate the prefix cache (per ADR 0012's append-only invariant). This is the behavioural complement to ADR 0012's ingestion control: same goal (smaller appends), reached by guiding the model rather than capping the tool.

## Relation to evaluation

Behavioural guidance is only as effective as the model's ability to follow it. Strong models comply; small local models may ignore the prompt and over-read anyway. This makes the discipline **measurable** and a useful eval signal (ADR 0011 §5): does a given profile actually Grep-then-slice, or dump whole files? Turn count, prompt-token growth, and tool-error rate in the trace reflect compliance. The enforcement question (§ above) matters most precisely for the models that *won't* self-comply.

## What we are NOT doing

- **Not** mandating a Grep before every Read — small/known files are read directly.
- **Not** blocking new-file creation (no Read required to create).
- **Not** implementing the hard Read-before-Edit check in this ADR — that is a separate, optional follow-up; here we only set the policy.
- **Not** adding new tools — this is discipline over the existing Grep/Read/Write/Edit set.

## Deferred / open questions

- **Enforcement strictness for Read → Edit.** Soft guidance is zero-risk but weak models may skip it; a hard check is stronger but can produce false positives (e.g. a file read in a *previous* thread, or read via Bash `cat`). Lean toward enforcing, with a clear error that tells the agent to Read first.
- **Tracking "read in this thread."** A hard check needs a per-thread set of read file paths (analogous to the existing visited-dirs tracking). Where it lives and whether it survives resumes is an implementation detail.
- **Nudge channel.** Guidance can live in the static system prompt *and/or* in the tool responses themselves (e.g. a large Read replying "…N more lines; Grep or slice to target"). The latter is more situational and may steer weak models better — to be weighed when/if implemented.
