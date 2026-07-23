# Next — parked items

A parking lot for decisions taken but deliberately *not* acted on yet. Each item
records what it is, why it's parked, and what would un-park it, so a future
session doesn't re-litigate a call that was already made. This is not a roadmap
(that lives in the ADRs) — it's the set of things we looked at, understood, and
chose to defer. Dated entries reflect what was true when written.

## Postponed

- **Team vs. workflow harness — THE open direction question after 0.19.** Two competing
  designs for multi-agent coordination, neither built:
  - **Team container:** [ADR 0018](adr/0018-team-as-derived-state.md) v2 (Proposed,
    2026-07-23) — ephemeral `<teamId>.team.json` with goal, members + per-team tasks,
    wake budget, `kind: "end"` termination; per-member threads, team-scoped address
    book injected at turn start, auto-wake within the team under a budget leash.
  - **Workflow harness:** Bruce's counter-model from the same discussion — defined
    who/when/what with feedback edges, gates, and termination baked into the flow
    itself. Motivation: local agents lack the Weitblick for self-organisation — "ein
    anarchistisches Scrum-Team könnte schneller scheitern als uns lieb ist"; a
    workflow carries the structure the models can't. No ADR yet (offered as a sketch).

  Discriminator before any code: **baseline dogfood** — run dev→reviewer→tester on
  the dashboard project in today's hub-and-spoke form (the lead routes) and see where
  the missing container/flow actually hurts. Bruce is thinking it over; do not build
  either until he and the lead have converged.

## Deferred (trigger-gated)

- **Context-diet package (analysed 2026-07-23, deliberately not built — Bruce wants to
  fully understand first; verdict was "sieht eigentlich gut aus").** Measured findings:
  agnz-repo threads start at ~12.6k tok baseline (**~34k chars of our own CLAUDE.md**
  in the frozen prefix — module map + ADR section dominate); dashboard threads start
  lean (~4.2k) but grew to 23.6k over 30 calls — composition: ~29k chars tool results,
  **~31k chars tool-call arguments (Write alone 23k — the agent carries its own written
  files as ballast)**, plus ~4k chars duplicate re-reads of unchanged fixtures during
  debugging. No literal duplication bugs found; growth is genuine payload. Slowness is
  ~90% the dense model (devstral-2 ~2 tok/s vs nemotron-MoE ~20 — Bruce keeps devstral
  for now). Candidate fixes, in order: (1) persist `visitedDirs` to thread meta — the
  once-per-dir CLAUDE.md guard is process-local and reset per run, so a resume can
  re-inject a subdir file (latent, zero real occurrences yet); (2) freshness map:
  `knownFiles` from path-list to `{path: {mtime, size}}` — enables "file changed,
  re-read first" blocks, skips needless re-reads, and lets a full re-read of an
  unchanged file answer "unchanged since your last read" (slice-aware only!);
  (3) ADR 0012 phase 2 batch compaction — stub out old tool results AND Write/Edit
  arguments (the ADR doesn't know that target yet), compact in rare batches at a ctx
  threshold so the KV-cache invalidation (unavoidable when shrinking a sequence) is
  paid once per batch, not per turn; (4) CLAUDE.md diet for sub-agents: dedicated
  `<cwd>/.claude/agnz/context.md` override + size cap with elision note as fallback.

- **ADR 0016 — harness calls — deferred.** Letting the loop reach for a local utility
  model for mechanical sub-steps. Un-parks when all three hold: a local utility model
  is actually installed, a `_utility` profile mapping exists, and the mechanical
  resume-card has proven insufficient in practice. Until then the card carries the
  mission and there's nothing for a harness call to improve.

## Open ADR 0015 questions

- **`meta.json` Read-fence.** The PreToolUse fence blocks direct `Read` of thread
  transcripts and traces, but `meta.json` is still readable. Open question whether to
  fence it too — it's small and structural (arguably fine to read), but it is a raw-file
  path the "ask, don't read" ladder would rather route through `show`.
- **`messages.jsonl` schema-sample mode — not shipped.** ADR 0015 floated a mode that
  surfaces a schema + a sample row instead of the raw log. Understood, not built.
- **Total write fence on agnz state — not built.** The surviving half of the old
  "config-CLI + write fence" idea (the config half shipped as ADR 0017 in 0.18.0):
  a `PreToolUse` fence against direct `Edit`/`Write` of files under `.claude/agnz/`,
  routing mutations through the CLI/`/agnz:setup` instead. Today only transcript/trace
  *reads* are fenced. Un-parks if a lead session is ever observed hand-editing state
  files and corrupting them; until then the JSON-with-locks layer hasn't needed it.

## Accepted non-fixes (from the adversarial release review)

Findings the three-lens review raised and we consciously accepted rather than fixed:

- **UPS fingerprint double-read lag — self-correcting.** The workspace fingerprint can
  lag one prompt behind a just-changed thread set; it reconciles on the next injection,
  so the transient is harmless.
- **Block-scalar chomping variants — accepted-but-clipped.** The zero-dep YAML block-scalar
  parser handles the folded/literal (`>`/`|`) forms we use; the chomping-indicator
  variants (`>-`, `|+`, …) are clipped rather than fully honoured. Accepted for our inputs.
- **`wait`'s final content deliberately uncapped.** Unlike `show`, the terminal payload
  `agnz wait` returns is *not* excerpt-capped — collecting the full outcome is the whole
  point of waiting on a run. By design, not an oversight.

## Closed — lessons kept

- **Test-suite flake (2026-07-20 → 2026-07-22, CLOSED with a stack trace).** Root
  cause: the loop's trace appends and `publish()` calls are fire-and-forget, so
  `runThread` can resolve while a write is still in flight; a test's `afterEach`
  recursive `rmSync` then races the straggler and dies `ENOTEMPTY` (victim test name
  random, retry always green — which is why it evaded capture five times). Durable
  rules: (1) every recursive cleanup `rmSync` in `tests/` passes
  `maxRetries: 10, retryDelay: 50` — copy that pair into any NEW test file that
  creates a workspace dir; (2) gate release chains on the test runner's **exit code**
  (`scripts/test.sh` does this and tees the log), never on a grep of its summary.
  Optional deeper fix, unbuilt: have `runThread` drain pending trace/publish writes
  before returning — only worth it if the retry fix ever proves insufficient.
