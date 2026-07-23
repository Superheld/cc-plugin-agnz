# ADR 0019 — The lead dashboard: one status model, judgments instead of readings

- **Status:** Proposed (discussion draft — do not implement before Bruce and the lead have converged)
- **Date:** 2026-07-23
- **Relates to:** ADR 0007 (parent context — this is its v2), ADR 0011 (observability — supplies the data and absorbs its §6 "workspace doctor" idea), ADR 0014/0015 (CLI + lead context discipline), ADR 0017 (config)

## Context

The lead's view of agnz grew surface by surface: the hook block (mail + thread list + spend + liveness), `agnz show` (structural view), per-thread errors on the meta, config failures as CLI errors at start time. Each piece works, but they were designed independently — "eher zufällig" (Bruce). Three concrete gaps:

1. **The lead does diagnosis by hand.** Observed in the wild (2026-07-23, dashboard project):

   > "der lastActivity-Timestamp ist unverändert (gleicher Read), nur agoMs ist von ~9,6 auf ~20 min gestiegen. Heißt: seit 20 min kein abgeschlossener Tool-Call — er hängt auf einem einzigen LLM-Call. Das ist am äußersten Rand des bisher Gesehenen."

   That is Claude manually diffing two timestamps across prompts and estimating "outside normal range" from memory. Every part of that derivation — *no completed tool call since X*, *hanging on one LLM call*, *far beyond this thread's normal* — is computable from data agnz already records (trace: a `turn_start` without a following `llm_call` **is** an in-flight LLM call; trace-stats knows the thread's median call latency). The dashboard's job is to deliver the conclusion, not the sensor values.

2. **No preflight.** Whether an agent can start at all — profile configured, `_default` mapped, server reachable, model loaded — the lead learns only from a failed `start`. "Sind die Configs gesetzt oder kann gar kein Agent gestartet werden?" has no surface today.

3. **Nothing owns the whole picture.** The hook renders one selection of fields, `show` another, `info` a third. A new signal (e.g. "last API error") must be wired into each by hand or it silently appears in only one place.

Constraints, from the lead's side of the glass (why this design and not a prettier one):

- **The lead is (nearly) stateless between prompts.** Anything the block does not say must be reconstructed by tool calls (turns) or by diffing older block copies still in context (attention, error-prone — see the quote). Time-derivative work (trends, "since when", "is this normal") is exactly what the lead is worst at and files are best at.
- **Every block line is paid on every prompt.** The block is lead context; ADR 0015 exists because that budget is the product. A dashboard in the "everything always visible" sense would be self-defeating.
- **Stable phrasing is machine-readable phrasing.** The lead pattern-matches. A line that always reads `hung: LLM call running 22m (median 2.4m) → agnz interrupt dev` is parsed at a glance; freshly-worded prose must be re-read.

## Decision (proposed)

**One status model with judgments, rendered severity-gated by every surface.**

### 1. `lib/status.mjs` — collect once, render N ways

A single module owns the workspace picture:

- `collectStatus(cwd)` → one struct: config health (profiles, `_default`, per-profile `contextWindow`), server contact (derived from recent trace events — see §4), per-thread facts (status, age, card spend, pending, last error, in-flight call duration, trace medians), unread mail counts, hygiene facts (idle age distribution).
- `judgeThread(facts)` → `{ state, evidence, action }` per thread (§2).
- Renderers consume the struct: `renderHookBlock` (severity-gated, delta-aware — today's fingerprint logic), the `show` no-target listing, `show <id>`, `info`. **No surface computes its own view of shared state any more.** A new signal lands in the struct once and appears everywhere it belongs.

### 2. Judgments, not readings

Each thread gets a verdict with evidence and the resolving verb attached:

| State | Trigger (self-calibrating where possible) | Rendered as (stable phrasing) |
|---|---|---|
| `working` | running, in-flight call/tool within normal range | quiet — folded into the summary line |
| `slow` | in-flight LLM call > k× this thread's median (k≈3), or no completed tool call for > k× median turn time | `slow: LLM call running 8m (median 2.4m) — watching` |
| `hung` | in-flight call > hard ceiling (e.g. 10× median, min 10 min) or runner pid dead while status=running | `hung: LLM call running 22m (median 2.4m) → agnz interrupt <name>` |
| `awaiting` | awaiting_input | `question waiting 6m: "…" → agnz answer <name> "…"` / approval equivalent |
| `done-unread` | idle with an outcome the parent cursor hasn't delivered | `finished: <summary> → collected at this prompt` |
| `error` | status error | `error: <message> → agnz remove <name> / start fresh` (server-down errors point at `agnz config test`) |
| `stale` | idle > 24h (today's rule) | aggregate line, as today |

Thresholds derive from the thread's own trace (median `llm_call` latency), not from config — a 2 tok/s devstral thread and a 20 tok/s nemotron thread each get judged against themselves. The `hung` detector is ADR 0011 §6's "workspace doctor", finally landing where it belongs.

### 3. Severity-gated rendering — the block is an exception report

- **All healthy:** one line. `agnz: 2 agents working (dev: Write lib/x.py 12s · reviewer: Read 3s)` — nothing else.
- **Each degradation adds exactly its lines.** An `awaiting` thread adds its question + verb; a `hung` thread adds its evidence + verb. Nothing else changes, so the byte-diff against the previous injection stays small (cache- and attention-friendly).
- **Workspace-level alerts outrank thread lines:** `no profile configured → agnz config add …` or `server unreachable since 14:02 (3 failed calls) → agnz config test` appear first — they answer "kann überhaupt ein Agent gestartet werden?" before a start fails.
- `agnz show` (no target) renders the SAME struct un-gated: the full board on demand.

### 4. No live probes in hooks

Hooks have a 5 s budget and run on every prompt; a hanging LM Studio ping would tax every prompt. Server contact is **derived**: the most recent trace `llm_call` (success) vs. recent thread errors matching connection failures → "last contact 40s ago" / "3 failed calls since 14:02". Live probing stays in explicit calls: `agnz config test` (exists) and `show` when asked (`--health`, folds an actual `/v1/models` round-trip in).

### 5. The interface teaches its own ops

Every non-quiet line ends with the resolving verb, exactly as typed (`→ agnz interrupt dev`). The lead should never have to derive the remedy from the diagnosis — that derivation is a reasoning step per prompt, and it is the same step every time. (Precedent: the stale-idle hint already does this with `agnz show <name>`.)

### 6. One vocabulary, two serializations (round 2, Bruce's sharpening)

What costs the lead interpretation is not the serialization format but **shifting vocabulary**: today the same thing is `thread_id` in CLI output and `id` in the meta; `name` means the thread address in one place and the def name in another (`agent`); `start` answers `status: "started"`, which is not a thread status. The dashboard standardizes the **glossary**, and every surface uses it verbatim:

| Field | Meaning | Rule |
|---|---|---|
| `thread_id` | the id (8-char short form in renderings, full in JSON) | never `id` |
| `name` | the address — what `send`/`answer`/`interrupt` take | |
| `role` | the agent def behind it (today confusingly `agent`) | |
| `status` | the raw state, exactly the thread enum | never ad-hoc values like `"started"` — verbs answer `{status, note}` |
| `verdict` | the judged state (§2) | |
| `since` | durations, one rendering everywhere (`22m`, `40s`) | |
| `evidence` | the data behind a verdict | |
| `action` | the resolving command, typeable verbatim | |

Serialization follows the consumer: **CLI verbs answer JSON** with exactly these keys (parseable, precise); **the hook block renders the same fields as a fixed line grammar** — marker, `name`, `[thread_id]`, `status/verdict`, `since`, `evidence`, `→ action`, always in that order. Lines are cheaper than JSON punctuation for a reader, and a fixed grammar is learned once ("nach drei Mal draufschauen verstanden").

### 7. One channel: agnz becomes a sender in its own message log (round 2)

"Jede Meldung geht durch diesen einen Kanal." Agent voices already flow through `messages.jsonl` → hook; **agnz itself is mute there**. Harness-level incidents — server unreachable on a send, a failed compaction, a runner found dead — land in CLI errors, traces, or nowhere. Fix: agnz publishes system events as `from: "agnz"` into the same log, same schema (`kind: "error" | "status"`), so there is exactly ONE event stream reaching the lead, agent and system voices in the same format. The dashboard then has precisely two inputs: the status struct (state, pull) and the unread event stream (news, push via hook) — nothing else exists.

## Not building

- **A web/graphical UI.** Bruce's external dashboard project reads the JSONL files directly; this ADR is about the *lead's* textual surface only.
- **Live streaming/push mid-run.** The pull model stands (ADR 0015); liveness stays derived from traces.
- **Config-knob thresholds.** Self-calibration from the thread's own trace; a knob would be a guess frozen at setup time.
- **Hook-time network I/O.** §4.

## Consequences

- The "zufällig" goes away structurally: surfaces can't drift because they render one struct.
- Hook cost in the healthy case *drops* (one line); cost appears only with the incidents that justify it.
- `hung`/`slow` detection turns the observed manual diagnosis into a computed line — the lead's example conclusion ("hängt seit 20 min auf einem LLM-Call, äußerster Rand") becomes a rendered fact with the verb attached.
- New module + a refactor of `_lib.mjs` hook rendering and `show` onto it; the fingerprint/delta logic is kept, fed by the struct.

## Open questions

- **`agent` → `role` rename** (§6) touches CLI output shapes and the hook block — mildly breaking for anything parsing today's JSON. Do it in the same release as the status model, or grandfather `agent` as an alias for one version?
- **System-sender noise budget:** which harness events deserve the channel? Lean: only what the lead can act on (server down, compaction failed, runner died) — never routine events (compaction succeeded belongs in the trace, not the mail).

- Does `info` fold into `show --health`, or stay a separate verb? Lean: keep `info` (environment) and give `show` the health flag (workspace) — different questions.
- `done-unread` vs. the existing mail delivery: the block already injects unread parent mail; is a separate state line redundant? Lean: yes, redundant — mail injection *is* the rendering; the state exists only in the struct.
- Should `slow` render at all, or only `hung`? Every rendered warning costs attention; `slow` may be noise at 2 tok/s. Lean: render `slow` only when the thread ALSO shows no tool progress (compound signal).
- Median needs ≥ N samples; cold threads (first call) have none. Fallback: workspace-wide median per model, else absolute floor (e.g. 15 min) only.
