# ADR 0011: Observability and evaluation

- **Status:** Proposed
- **Date:** 2026-05-31
- **Branch:** `claude/observability-strategy-testing-AZMLM`
- **Depends on:** [ADR 0001](./0001-workspace-first-architecture.md), [ADR 0002](./0002-communication-mailbox-and-events.md), [ADR 0007](./0007-parent-context.md)

## Context

The whole premise of agnz is that a **local model** does grunt work so the parent Claude spends fewer Anthropic tokens. Two questions follow directly from that premise, and today we can answer neither with data:

1. **Did it actually pay off?** We claim the parent's context only grows by the sub-agent's final answer, and that local tokens are free. We have no aggregated view of token spend, turns consumed, or how much parent context a delegation saved. The numbers exist per turn (the `usage` trace event added in 0.11.9) but are never summed.

2. **Was the work any good?** Local models vary wildly — Devstral, Qwen-Coder, and a small Llama produce very different tool-calling reliability and edit quality. We have no way to measure whether a given model/profile is good enough for a given agent role. Picking a model is currently vibes.

### What we have today

Observability is already present but fragmented across three persistence layers:

| Artefact | Location | Content |
|---|---|---|
| Transcript | `<cwd>/.claude/agnz/threads/<id>.jsonl` | Append-only OpenAI-format messages (user/assistant/tool) |
| Meta snapshot | `<cwd>/.claude/agnz/threads/<id>.meta.json` | `status`, `pending`, `error`, `sessionCommands`, `agentDef`, timestamps |
| Runtime trace | `<cwd>/.claude/agnz/threads/<id>.trace.jsonl` | `thread_start`, `turn_start`, `usage` events |
| Message log | `<cwd>/.claude/agnz/messages.jsonl` | Durable agent↔parent event log (monotonic ids, ADR 0002) |

Inspection surfaces:

- `skills/agnz-threads/` + `scripts/inspect.sh` — jq formatter: thread list and transcript tail in the terminal.
- The parent reads `meta.json` directly for a status peek (no MCP call).
- `UserPromptSubmit`/`SessionStart` hooks inject unread `to:parent` mail.
- `notifier.mjs` fires an OS notification for `urgent` mail addressed to `parent`.

Tests: `tests/` covers only data plumbing (`thread-index`, `workspace-store`, `data-dir`) with `node:test`. The agent loop, the sandbox, and the mailbox drain — the parts most likely to break — have no coverage.

### The gaps, ranked

1. **No aggregated view.** Trace is per-thread. No "all agents, cumulative tokens, success rate, turn distribution."
2. **Trace is thin.** No tool-call latency, no LLM round-trip time, no record of errors/retries (e.g. the JSON-repair path in `loop.mjs`), no `finishReason` capture, no terminal-reason event.
3. **No token/savings story for the parent.** The product's reason to exist is unmeasured.
4. **No live monitoring.** Status is pull-only (read a file). ADR 0007's workspace-summary hook is still proposed, not implemented.
5. **No evaluation.** Zero machinery to measure whether a local model did a task *well*.
6. **Loop/sandbox untested** (also called out in CLAUDE.md's Known Gaps).

## Decision

Five parts. All file-based and zero-dependency, consistent with the rest of the plugin — but the trace schema is deliberately designed to map cleanly onto OpenTelemetry so an external exporter can be bolted on later without a rewrite (§6).

### 1. A complete, structured trace schema

`lib/trace.mjs` stays the single writer. The `appendTrace(thread, entry)` contract (silent, fire-and-forget, `ts` auto-stamped) is unchanged. We expand the event vocabulary so `<id>.trace.jsonl` becomes a real telemetry stream rather than a debugging breadcrumb:

| Event `type` | When | Key fields |
|---|---|---|
| `thread_start` | first run only | `tools[]`, `systemPrompt`, `agent`, `model`, `profile` |
| `turn_start` | before each LLM call | `turn`, `systemPrompt` |
| `llm_call` | around each `chat()` | `turn`, `latencyMs`, `finishReason`, `usage{prompt,completion,total}` |
| `tool_call` | around each tool dispatch | `turn`, `name`, `latencyMs`, `outcome` (`ok`/`error`/`denied`/`paused`), `argsPreview` |
| `repair` | JSON-argument repair fires | `turn`, `tool`, `recovered` (bool) |
| `pause` | approval/question pause | `turn`, `kind`, `tool` |
| `thread_end` | terminal state | `reason` (`final`/`max_turns`/`error`/`stopped`), `turns`, `totals{...}` |

`usage` is folded into `llm_call` (it was a standalone event in 0.11.9; superseded). The existing `turn === 0 ? "thread_start" : "turn_start"` branch in `loop.mjs` is kept; the new events are added at their natural call sites:

- `llm_call` wraps the `chat()` call (timestamp before/after for `latencyMs`; `finishReason` and `usage` already returned by the client).
- `tool_call` wraps `runToolAndAppend` / the dispatch in `dispatchToolCall`.
- `repair` is emitted in the `catch (_firstErr)` JSON-repair branch.
- `thread_end` is emitted at each of the loop's three exits (final, max_turns, error).

These all stay fire-and-forget. Latency measurement is `Date.now()` deltas — no high-res timers, no new deps.

### 2. Aggregation and display

A single read-only aggregator, `lib/trace-stats.mjs`, folds a thread's `trace.jsonl` (and, for workspace-wide views, all threads via the thread index) into a summary:

- per thread: turns, cumulative tokens (prompt/completion/total), total LLM latency, tool-call count by outcome, repair rate, terminal reason, wall-clock duration;
- per workspace: the above summed, plus per-agent and per-model breakdowns.

Display follows the existing pattern — no server, no dashboard daemon:

- **`inspect.sh` gains a stats mode.** `inspect.sh stats` (workspace totals) and a per-thread stats block prepended to the transcript view. Stays jq/bash, optional.
- **`agnz-threads` skill** documents the stats view so the parent can ask for it.
- **Optional static report.** A `scripts/report.mjs` that renders a Markdown (or self-contained HTML) timeline + token chart from `trace.jsonl` for a thread. Generated on demand, never served. Deferred to a follow-up if §1–§2 prove insufficient.

### 3. Parent monitoring (implements the ADR 0007 hook)

The "no live monitoring" gap is exactly what ADR 0007 §1 Layer 2 specifies. This ADR commits to implementing it and feeds it the stats from §2:

- The `SessionStart`/`UserPromptSubmit` hooks inject the ADR 0007 workspace summary (active threads, status, last activity) **plus** a one-line spend figure per active thread (`turns · tokens`) drawn from `trace-stats`.
- Push for the exceptional: extend the existing urgent-notification path so a thread approaching `maxTurns` or exceeding a configurable token budget publishes a `status` message to `parent`. Reuses `event-bus.publish` + `notifier.mjs`; no new channel.
- A `workspace doctor` check (in the setup companion or a new sub-command) flags `running` threads with no `updatedAt` bump for N minutes — the hung-thread detector.

### 4. Testing strategy (correctness, deterministic)

The biggest stability lever and it is currently empty. Add `node:test` coverage for the untested core, using a **fake LLM** so tests are fully deterministic and need no running model:

- A `chat()` test double that returns scripted assistant messages (with/without `tool_calls`). The loop already takes its client via the module under test — we inject responses, not a live endpoint.
- Loop paths: single tool call, multi-tool-call turn where one pauses (`drainLeftoverToolCalls`), pause→resume for both `approval` and `question`, `max_turns` tail behaviour, error propagation.
- Sandbox: path-escape refusal, symlink-escape, the three permission decisions.
- Mailbox: `drainMailbox` cursor advance (delivered vs. merely observed), self-message skip.
- Trace: assert each loop exit emits a `thread_end` with the right `reason` — this makes the schema in §1 self-verifying.

These run in CI-equivalent `node --test` with no network and no model.

### 5. Evaluation harness (quality, non-deterministic)

Distinct from §4. The question is "is this local model good enough for this role?", which is inherently fuzzy and model-dependent. Structure:

- **Fixtures.** A `evals/` directory of self-contained tasks: a seed repo state, a prompt, and a *programmatic assertion* on the outcome (file content, `Bash` exit code, "edited the right file and nothing else"). Assertions check the result, not the transcript wording.
- **Runner.** Executes each fixture against one or more named profiles, in a throwaway `tmp/` workspace, and records pass/fail.
- **Scorecard.** Combines the boolean pass/fail with metrics pulled from §1's trace: turns-to-completion, total tokens, tool-error rate, and repair rate (a strong proxy for "this model can do tool-calling"). Output is a per-model table.

This directly answers the product question — *which local model for which agent role* — and gives a regression signal when a model or a prompt changes.

### 6. External telemetry: schema kept open, exporter deferred

We do **not** add an OpenTelemetry dependency now (zero-dep rule). But we design the §1 schema so the door stays open:

- Trace event fields use OTel-span-compatible naming where natural: a `thread` is a trace, a `turn`/`tool_call`/`llm_call` is a span with `latencyMs` (→ duration), `outcome` (→ status), and a stable `name`. `ts` is the span start.
- An exporter is a pure, isolated reader: it tails `trace.jsonl` and maps events to spans. It lives behind an opt-in env var (e.g. `AGNZ_OTEL_ENDPOINT`) and is the *only* place an OTLP/HTTP emitter would be added — if ever. Because it only reads the durable trace files, it cannot affect the loop and needs no changes to `trace.mjs`.
- Until someone sets that env var, nothing ships and nothing is imported. The schema commitment is the deliverable here, not code.

## What we are NOT building in this ADR

- **A live dashboard / web UI / daemon.** File-based views only. A static report (§2) is the ceiling, and it is deferred.
- **An OpenTelemetry dependency.** Schema compatibility only (§6). No `node_modules`.
- **Cross-workspace / user-wide aggregation.** Per-workspace stats only, consistent with the two-roots model. A global "all my agents ever" view is deferred.
- **LLM-judged evaluation.** §5 uses programmatic assertions on outcomes. Using a model to grade output quality is a separate, later question.
- **Sampling / trace rotation.** We write every event. `trace.jsonl` growth is acceptable at current volumes; pruning is deferred (see below).

## Deferred / open questions

- **Trace file growth.** With `llm_call` + `tool_call` per turn, traces grow faster. A size cap or a `/agnz:threads prune` that drops trace files for stopped threads is deferred until it bites.
- **Cost translation.** Token counts are model-native. Mapping local tokens to a notional cost (and contrasting with the Anthropic tokens *saved*) needs a per-profile price field; deferred to a profile-schema change.
- **Eval fixtures need maintenance.** Fixtures encode expected outcomes that drift as the plugin evolves. Keeping them green is real work; we start with a handful of high-value tasks, not a broad suite.
- **`finishReason` semantics across providers.** LM Studio, Ollama, and OpenRouter don't all populate `finish_reason` identically. The `llm_call` event records whatever the client returns; normalising it is a follow-up.
