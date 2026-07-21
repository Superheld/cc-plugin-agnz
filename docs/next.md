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

- **Test-suite flake.** Two occurrences (2026-07-20: 2 tests; 2026-07-21: 1 test), both
  in the run chained directly after a `git merge`, both green on immediate retry, names
  not captured either time. Does NOT reproduce via bare branch-switch cycles (5 tried)
  or back-to-back runs (15+ clean). Working hypothesis: I/O-load-sensitive timing
  (proc-lock acquisition or a child-process timeout) in the post-git moment. If it
  recurs, **run with full output and capture the failing test names first** — counts
  alone (the mistake made twice now) leave nothing to chase.
