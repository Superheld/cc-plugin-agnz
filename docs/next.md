# Next — parked items

A parking lot for decisions taken but deliberately *not* acted on yet. Each item
records what it is, why it's parked, and what would un-park it, so a future
session doesn't re-litigate a call that was already made. This is not a roadmap
(that lives in the ADRs) — it's the set of things we looked at, understood, and
chose to defer. Dated entries reflect what was true when written.

## Postponed

- **Config-CLI + total write fence + ADR 0017 — postponed.** The idea: a first-class
  config surface plus a hard fence against direct edits of agnz state. Blocked on a
  prior decision — Bruce wants to rework *where config lives* first. Today it's spread
  across three places with three lifetimes: profiles are user-wide
  (`~/.claude/agnz/profiles.json`), model→profile mappings are per-workspace
  (`workspace.json`), and agent defs live in Claude Code's standard paths
  (`~/.claude/agents/`, `<cwd>/.claude/agents/`). Consolidate that story before
  designing the CLI/fence on top of it, or ADR 0017 just cements the sprawl.

- **Team awareness for sub-agents — needs a design discussion (Bruce, 2026-07-22).**
  Agent-to-agent messaging exists mechanically (`SendMessage(to: <name>)`, mailbox
  drain at turn start) but is invisible to the agents: no roster, no idea what
  teammates specialise in, no discovery. The self-context fix (agent knows its own
  name/address, deny semantics, turn budget) shipped; everything beyond that is
  deliberately NOT built yet. Points for the discussion: (a) should inter-agent
  messaging be its own tool or stay a `SendMessage` addressing mode; (b) where does
  the roster come from — static injection at thread start goes stale in the frozen
  prefix, so teammate info probably belongs in the turn-start injection alongside
  the inbox; (c) Bruce's sketch: when an agent hits a question/task outside its own
  goal, it should get information about its surrounding (who else exists, who owns
  what), mail the right party, and either wait or continue — half-formed, revisit
  together before building anything.

## Deferred (trigger-gated)

- **ADR 0016 — harness calls — deferred.** Letting the loop reach for a local utility
  model for mechanical sub-steps. Un-parks when all three hold: a local utility model
  is actually installed, a `_utility` profile mapping exists, and the mechanical
  resume-card has proven insufficient in practice. Until then the card carries the
  mission and there's nothing for a harness call to improve.

## Parked (cost vs. gain)

- **`systemPromptSnapshot` sidecar file — parked.** Moving the frozen prompt prefix out
  of `meta.json` into its own sidecar would slim the meta that `show`/hooks read. Parked:
  the migration cost (existing threads carry the snapshot inline) outweighs the small
  per-read win now that `show` already omits the snapshot from its structural view.

## Open ADR 0015 questions

- **`meta.json` Read-fence.** The PreToolUse fence blocks direct `Read` of thread
  transcripts and traces, but `meta.json` is still readable. Open question whether to
  fence it too — it's small and structural (arguably fine to read), but it is a raw-file
  path the "ask, don't read" ladder would rather route through `show`.
- **`messages.jsonl` schema-sample mode — not shipped.** ADR 0015 floated a mode that
  surfaces a schema + a sample row instead of the raw log. Understood, not built.

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

## Watch

- **Test-suite flake.** Three occurrences (2026-07-20: 2 tests; 2026-07-21: 1 test;
  2026-07-21 late: 2 tests, then 1 test on the *immediately following* run — first time
  it failed twice in a row), all in or right after the run chained directly behind a
  `git merge`, all green within 1-2 retries, names not captured any time (the
  names-first mistake is now three for three: even a deliberate capture attempt piped
  through `grep '^ℹ'` and lost them). Does NOT reproduce via bare branch-switch cycles
  (5 tried) or back-to-back runs (15+ clean). Working hypothesis unchanged:
  I/O-load-sensitive timing (proc-lock acquisition or a child-process timeout) in the
  post-git moment; occurrence 3 followed the largest merge yet (20+ files), which fits.
  If it recurs: `node --test tests/*.test.mjs 2>&1 | tee /tmp/flake.log` FIRST, grep
  afterwards. Process lesson from occurrence 3: the release chain gated on
  `grep '^ℹ (pass|fail)'` — which exits 0 on a *match*, including "fail 2" — so a red
  suite did not stop the pipeline. Gate release chains on the test runner's exit code
  (`node --test ... && git merge ...`), never on a grep of its summary.

  **Hunt (2026-07-22, quality pass):** deliberate reproduction attempts failed —
  10 full-suite runs each chained directly behind a 40-file `git merge` in an
  isolated clone (0 red), plus 20 runs of the prime-suspect file under sustained
  `dd`+`sync` disk load with `UV_THREADPOOL_SIZE=2` (0 red). Structural analysis
  found exactly one bounded wait on fire-and-forget disk I/O in the whole suite:
  `waitForTrace` in `tests/loop-trace.test.mjs`, 1 s deadline, two call sites —
  which matches every observed occurrence (1–2 tests red, green on retry,
  I/O-load correlation; the trace append can lag behind `runThread` resolving).
  Actions taken: deadline raised 1 s → 10 s (poll exits early when green, so the
  ceiling is free), and `scripts/test.sh` added — tees the full log, echoes
  failing names on red, exits with the runner's verdict — so the names-first and
  exit-code-gating lessons are now tooling, not discipline. Watch continues: if
  the flake recurs *despite* the raised deadline, the hypothesis is falsified
  and the names will finally be on file.

  **CLOSED (2026-07-22): root cause caught with a stack trace.** The flake
  recurred twice in back-to-back full-suite runs and the log finally had the
  error: `ENOTEMPTY … rmSync` thrown from a test file's `afterEach` — NOT an
  assertion, NOT `waitForTrace` (that hypothesis is hereby falsified; the 10 s
  deadline stays as harmless hardening). Mechanism: the loop's trace appends and
  `publish()` calls are fire-and-forget, so `runThread` can resolve while a
  write is still in flight; `afterEach`'s recursive `rmSync` then races it —
  the straggler re-creates a file inside a directory `rm` has already emptied,
  and the final `rmdir` fails ENOTEMPTY. That's why the failing test name was
  never the same (the victim is whichever test is cleaning up) and why retries
  were always green. Fix: every recursive cleanup `rmSync` in `tests/` now
  passes `maxRetries: 10, retryDelay: 50` — Node re-scans the directory on
  ENOTEMPTY retry, sweeping the straggler. Copy that option pair into the
  `afterEach` of any NEW test file that creates a workspace dir. (Optional
  deeper fix, unbuilt: have `runThread` drain pending trace/publish writes
  before returning — would make traces deterministic and `waitForTrace`
  unnecessary; only worth it if the retry fix ever proves insufficient.)
