# ADR 0015: Lead-side context discipline

- **Status:** Proposed
- **Date:** 2026-07-20
- **Depends on:** [ADR 0002](./0002-communication-mailbox-and-events.md), [ADR 0007](./0007-parent-context.md), [ADR 0013](./0013-tool-workflow-discipline.md), [ADR 0014](./0014-cli-replaces-mcp.md)

## Context

agnz exists to keep the parent Claude session's ("the lead's") context small — the
sub-agent does the heavy file work, the lead sees only the distilled outcome. Current
practice undermines that goal in two ways, both taught by our own docs.

**(a) Blocking runs.** `--wait` on `start`/`send` runs the segment inline instead of
detaching. The docs recommend it "for short tasks," so the lead reaches for it
habitually — which serializes work that the detached multi-process model
(ADR 0014) exists to parallelize. It is also a footgun: Claude Code's Bash tool has
a default 2-minute timeout, and killing that Bash call kills the inline runner
**mid-segment**. Opportunistic stale-run recovery (ADR 0014) notices the corpse
next time round, but the work already in flight is lost, not resumed.

**(b) Transcript reading.** The lead reads `.claude/agnz/threads/<id>.jsonl` directly
— `skills/agnz-threads/SKILL.md` literally instructs this. Transcripts carry
verbatim tool results up to 512 KiB, so a single read can blow the very context
budget the plugin exists to protect. Even the "safe" inspection path is not safe
enough: `agnz show` currently returns the last 6 transcript messages uncapped
(`bin/agnz.mjs`, `recent: msgs.slice(-6)`), so routine status checks can flood the
lead with a handful of large tool results.

Both failures share a root cause: nothing in the harness enforces the
pull-not-push principle on the *lead* side. ADR 0013 solved the symmetric problem
for the sub-agent (Grep-before-Read, Read-before-Write, as harness logic, not just
prompt text). The lead has no equivalent discipline — today it is guidance in
prose that a busy lead skips under time pressure, exactly like an unguided local
model over-reads.

## Evidence from dogfooding

A lead session working in a real test project needed a *structural* view of an
agnz workspace — what threads exist, roughly what happened, what state they're
in — and reached for raw `Read` on the agnz-internal files because that was the
only first-reach tool available, not out of laziness. What it actually needed
turned out to be much smaller than what it read: `meta.json` without the two
heavy embedded fields, a reduced view of `trace.jsonl` (event shape plus the
`thread_end` totals, no embedded prompts), and a single sample record from
`messages.jsonl` to see the schema rather than the content. Its own framing was
blunt and worth repeating as this ADR's guiding sentence: give the lead a
token-lean structural view of agnz-internal artifacts as the default first-reach
tool, and it will never touch the raw file at all. That reframes the problem —
the fence in point 4 below is a backstop for the reflex that remains once the
better tool exists, not the primary fix.

## Decision

**1. Detached becomes the only run mode.** Remove `--wait` from `start`, `send`,
`approve`, `answer`. Add a new verb, `agnz wait <id> [--timeout <s>]` — a
*watcher*, not a *worker*: it polls the thread meta with backoff and prints the
outcome once the thread leaves `running`. On timeout, only the watching call
dies — the detached runner keeps working underneath it, and the lead can call
`wait` again or fall back to the hook. This enables the pattern the detached
model was built for: start N agents detached, do other work, then collect with
`wait` (or let the hook deliver results passively). The inline path in
`lib/orchestrate.mjs` stays — the eval harness (ADR 0011 §5) needs synchronous
runs — only the CLI-level `--wait` flag goes.

**2. A token-lean structural view as the default inspection surface (centerpiece).**
This is the direct answer to the dogfooding evidence above, and it supersedes a
narrower "just cap `show`'s recent messages" fix — the actual gap is broader
than the transcript excerpt. Candidate shape, exact verb surface left open at
Proposed level:

- `agnz show` returns `meta.json`'s content *minus* its two heavy embedded
  fields (`systemPromptSnapshot`, `agentDef`'s full body), plus the fields a
  lead actually asks "show" for: status, pending, spend. The per-message
  `recent` excerpt still gets a character cap with an elision marker reporting
  the original size, so a status check can never forward a full tool result —
  but that cap is now one piece of a bigger picture, not the whole fix.
- The trace half of this already exists: `lib/trace-stats.mjs`'s fold
  (turns/tokens/latency/tool-outcomes/repair-rate) is exactly the "event core
  plus `thread_end.totals`, no embedded prompts" shape the evidence asked for.
  Surface it through `show` (or a flag on it) instead of leaving it as a
  separate call the lead has to know to make.
- A schema-sample mode for `messages.jsonl` — one representative record, not
  content — for the rare case the lead needs to reason about message shape
  rather than message history.

**3. "Ask, don't read" as the guiding principle.** The thread already carries its
own context — asking it a question costs local tokens; reading its transcript
costs lead context. The intended escalation ladder, cheapest first:

1. the workspace summary block (ADR 0007's `UserPromptSubmit` injection) — free,
   already in context;
2. `agnz show <id>` — the lean structural view from point 2, one call;
3. ask the thread directly — `agnz send <name> "clarifying question"` — spends
   local tokens, not lead context;
4. last-resort debugging via the skill's `inspect.sh`, which tails with its own
   caps.

Reading the raw `.jsonl` transcript is deliberately *not* a rung on this ladder
for routine use.

**4. Enforcement as backstop, not the fix.** A `PreToolUse` hook (wired through
the plugin's `hooks/hooks.json`) blocks the lead's `Read` tool on
`.claude/agnz/threads/*.jsonl` and `*.trace.jsonl` — transcripts and traces —
with a non-zero exit and a message pointing at `agnz show` / `agnz send`. This
exists to catch the residual reflex after the better tool (point 2) is in
place, not to substitute for it — a fence with no good alternative behind it
is just friction, one with three better options behind it is discipline. The
fence is deliberately porous:

- `Grep` stays allowed against the transcript/trace files — it returns only
  matches, so it's context-cheap and a legitimate way to find "did tool X run"
  without pulling the whole file.
- `Bash`/`inspect.sh` stays as the debugging escape hatch — it tails with caps
  by design, so routing around the direct-`Read` block through it does not
  reopen the hole.
- `meta.json` is **not** listed as a safe exception here — it is not small.
  It embeds `systemPromptSnapshot` (the frozen system-prompt prefix, ADR 0012 —
  routinely tens of KB) and the full `agentDef`, body included. Whether the
  `Read` fence should also cover raw `meta.json` reads (as opposed to reads
  through the trimmed `show` surface from point 2) is an open question below,
  not a settled exception.

This mirrors ADR 0013's shape one level up the stack: ADR 0013 gave the
*sub-agent* workflow discipline as harness logic because prompt text alone is
too weak for a small local model to reliably follow under its own steam; this
ADR gives the *lead* the same kind of harness-enforced discipline, because a
busy lead under time pressure is subject to the same failure mode as an
unguided model — reach for the direct, expensive path because it's right there.
The difference in emphasis matters, though: for the sub-agent, the interceptor
*is* the mechanism (ADR 0013 has no cheaper positive alternative to build
first). For the lead, the positive tool (point 2) comes first and does most of
the work; the fence only catches what's left over.

## Consequences

- **CLI surface change.** A flag (`--wait`) is removed and a verb (`wait`) is
  added on `start`/`send`/`approve`/`answer`. Per the versioning rule in
  `CLAUDE.md`, a breaking CLI surface change is a **minor** version bump.
- **Docs and skills must be rewritten in the same branch as the code change.**
  In particular `skills/agnz/references/lifecycle.md`'s "read the transcript
  directly" guidance and `skills/agnz-threads/SKILL.md`'s "Inspect one thread"
  section (`Read: .claude/agnz/threads/<id>.jsonl`) go away or are rewritten to
  the new ladder.
- **Ordering is deliberate: the fence lands last.** Points 1–3 (watcher verb,
  the lean structural view, the documented ladder) ship first and must stand on
  their own merits before point 4 (the hard block) goes in — see the
  centerpiece/backstop framing above. This is a fairness ordering, not a
  technical dependency.
- **`agnz wait` needs its own timeout/backoff design** (poll interval, max
  wait, what "leave running" means for a thread that immediately re-enters
  `running` via reuse-by-name) — left to the implementation branch.

## Open

- Exact shape of the trimmed `show` output and its verb surface (a flag on
  `show`, vs. a separate structural-view verb) — left to the implementation
  branch.
- Exact per-message cap for `show`'s `recent` field (500 chars is a starting
  guess, not measured).
- **Whether the `Read` fence should also cover raw `meta.json` reads.** Given
  `meta.json` embeds the heavy `systemPromptSnapshot` and `agentDef` fields,
  it is not the small/safe case it might look like at first glance — but
  blocking it outright would also block the one field (`pending`) a lead might
  legitimately want straight from disk during a fast status check, before
  point 2's trimmed `show` surface exists. Revisit once point 2 ships and it's
  clear whether anyone still reaches for raw `meta.json`.
- Whether the `PreToolUse` block should also cover a lead attempting `Grep`
  with an unbounded `-A`/`-B`/`-C` context flag against a transcript file — for
  now, out of scope; `Grep` stays unconditionally allowed per the "matches
  only" reasoning above.
