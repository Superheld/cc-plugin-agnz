# ADR 0018 — Teams: an ephemeral container, derived contents

- **Status:** Proposed, v2 (discussion draft — do not implement before Bruce and the lead have converged)
- **Date:** 2026-07-23 (v2 same day — v1's object-less model was revised after round 3 of the discussion, see "Considered and rejected")
- **Relates to:** ADR 0002 (mailbox), ADR 0003 (agent definitions), ADR 0004 (board — still unbuilt), ADR 0008 (brain — explicitly fenced off), ADR 0012 (frozen prompt prefix)

## Context

agnz is architected for concurrent agents (detached OS processes, per-agent mailboxes, `SendMessage(to: <name>)`), but the agents are **mutually invisible**: no agent knows who else exists, what they specialise in, or what they are working on. The team layer exists mechanically and is absent experientially.

Constraints and findings from the 2026-07-23 discussion (three rounds):

1. **Goals are epic-scoped, not project-scoped.** A team works on epic 1, then a new goal follows with epic 2 — same or different members. Anything stored in project config is stale by construction.
2. **Solo use must stay frictionless.** Spawning one reviewer must not require creating, naming, or dissolving anything.
3. **Late joiners and the frozen prefix.** Anything baked into the frozen system-prompt prefix (ADR 0012) describes the world at thread start; membership knowledge must be delivered dynamically (turn-start injection), never in the prefix.
4. **The workspace is the wrong scope for an address book** (round 3, killed v1). Live threads in one workspace can belong to unrelated missions — janitor jobs, probes, a different epic. "Every live thread sees every other" is noise and invites cross-talk between unrelated missions. The *mission* is the right scope, and it needs an explicit boundary.
5. **A crew needs termination semantics** (round 3). Without an explicit "my part is complete" signal, nobody — not the members, not the lead — can distinguish "idle, waiting for input" from "done". v1 had no answer; a team model must.

One hardware note defuses the scheduling worry: with all agents on the **same local model**, the inference server serialises requests — N "parallel" agents interleave at the token level automatically; the server queue is the scheduler. Only mixed-model teams (swap thrashing) would ever need a real concurrency brake; that stays unbuilt until it hurts.

## Decision (proposed)

**The team is an explicit, ephemeral container. Everything *inside* it is derived from state that already exists.**

The container is the boundary (membership, goal, budget, termination). The contents stay cheap: who a member is, what they specialise in, and what they are doing right now all come from agent defs, thread metas, and resume cards — nothing is duplicated into a second registry that could drift.

### 1. The team container

A team is created at spawn time (epic-scoped, constraint 1) and lives as `<teamId>.team.json` beside the threads:

```json
{
  "id": "…",
  "name": "billing-rework",
  "goal": "Epic 2: rebuild the billing flow against the new API",
  "members": [
    { "name": "dev",      "agent": "dev",      "task": "implement the flow" },
    { "name": "reviewer", "agent": "reviewer", "task": "review every change dev announces" },
    { "name": "tester",   "agent": "tester",   "task": "write and run e2e tests" }
  ],
  "budget": { "wakes": 30 },
  "status": "working",
  "ended": []
}
```

- **Each member keeps its own thread**; the team is the clamp around them (`teamId` on the thread meta). A single shared multi-party transcript was considered and rejected: local models need strict role alternation, and "whose turn is it" in a shared transcript is exactly the kind of ambiguity that breaks chat templates. Per-member threads under one umbrella give the same behaviour without the risk.
- The per-member `task` is the team-scoped role ("welche Aufgabe sie in diesem Team haben") — sharper than the def's generic description, written by the lead at team start.
- Teams are ephemeral: `stop`/`remove` on the team sweeps the container (and archives/deletes member threads like today's verbs do).

### 2. Scoped address book

A member's turn-start injection (alongside inbox mail) carries the **team block**: goal + one line per teammate — `name — team task — status/current activity` — derived fresh every turn from defs, metas, and cards. Members can only address teammates (+ `parent`); **an agent spawned without a team has no peer recipients at all** — `SendMessage` to anything but `parent` fails with "you have no team". That is the solo case handled by construction (constraint 2): no roster section, no recipients, no overhead, byte-identical to today.

Names are **team-scoped**: "reviewer" resolves within the team; two teams can each have a "reviewer" without collision.

The address book is context, never tool schema — dynamic names inside the `tools[]` payload would mutate the prompt every turn and break prefix caching (ADR 0012).

### 3. Auto-wake within the team — with a leash

Inside a team, mail wakes its recipient: a member's `SendMessage(to: "reviewer", …)` spawns the reviewer's runner if it is idle (delivery stays turn-start drain — the wake just creates the turn). This is what makes the crew an actual autonomous unit rather than a lead-driven relay: they work in a shared context toward the goal, and the lead supervises rather than routes.

The leash, because `maxTurns` bounds only a single run and auto-wake creates *new* runs without limit (A asks B, B asks A, …):

- The team `budget` (e.g. `wakes: 30`) counts every auto-wake. Exhausted → no further auto-wakes; the team pauses and the lead is notified (`to: parent`, urgent) to decide: raise the budget, intervene, or stop.
- The lead's own `send` never counts against the budget and always works.
- Per-run `maxTurns` still applies to every member run, unchanged.

**Outside a team, nothing auto-wakes** — mail to a team-less idle agent would lie unread, which is why team-less agents have no peer recipients in the first place. (v1's "lead-mediated wake" survives only as the answer for *cross-team* or parent-directed mail, if that ever becomes a need.)

### 4. Termination: end declarations

A new message kind **`end`** ("my part is complete", with a short result summary as text). Team bookkeeping records who has ended (`ended: [...]`). The team reaches `done` when **every member has declared end and no unread intra-team mail remains** (an unread question re-opens work: waking the recipient clears its inbox; a member that already declared end and then receives mail is woken again and may withdraw its end simply by working — its next end declaration re-closes it).

The lead sees end declarations and the team status through the usual channels — hook block (team line: `billing-rework — 2/3 ended · 12/30 wakes`) and `agnz show <team>` for the structural view — and decides what happens next, as today. Nothing terminates silently.

### 5. Agent = named thread; the lead starts an agent or a team

Unchanged from v1, now team-namespaced: the member name is the identity *within its team*, the thread is its memory, the def is only the role. "Same role, fresh head" = a new name (or a new team). Persistent cross-thread/cross-team agent identity is deliberately fenced off to ADR 0008 (brain) — an identity that remembers nothing between threads is just a reused string, and the boundary keeps the messaging layer from half-building a brain.

CLI shape (sketch, to be refined at implementation): `agnz start` unchanged for solo agents; `agnz team start <name> --goal "…" --member <name>:<def>:"<task>" …` (or a spec file passed inline) for crews; `show`/`stop`/`remove` accept a team name and operate on the container.

## Considered and rejected

- **`team: {name, goal}` in project config** — rejected: epic-scoped vs. project-scoped mismatch (constraint 1).
- **v1: no team object, workspace-wide derived roster** — rejected in round 3: the workspace is the wrong scope (unrelated missions would see each other — constraint 4), and it had no termination semantics (constraint 5). Its core survives as the *contents* rule: everything inside the container is derived, nothing is registry-duplicated.
- **Roster in the frozen system prompt** — rejected: stale for late joiners/leavers; turn-start injection subsumes it (constraint 3).
- **One shared team transcript** — rejected: breaks strict role alternation for local-model chat templates (§1).
- **Unbounded auto-wake** — rejected: ping-pong between two members could burn tokens indefinitely with nobody having asked for it; hence the team budget (§3).
- **Persistent agent identity across teams/threads** — deferred to ADR 0008; see §5.

## Consequences

- Solo use is byte-identical to today; team-ness is opt-in per mission.
- A team is a genuine autonomous unit: members see each other, wake each other, and declare completion — the lead supervises (hook block, `show`, budget alarms) instead of routing every handoff.
- New surface: the team container file, `kind: "end"`, the wake budget, team-aware `start`/`show`/`stop`/`remove`, and the runner-spawn path in the event bus (publish → wake). This is deliberately more machinery than v1 — the discussion concluded the boundary and the termination semantics are worth exactly this much.
- Known limitation to document: two members editing the same files can conflict; roles usually partition writes naturally (dev writes, reviewer reads), but nothing enforces it. The board (ADR 0004) would be the structural fix if dogfooding shows it hurts.

## Validation before building

Dogfood the target crew — **dev → reviewer → tester on the dashboard project** — *first* in today's hub-and-spoke form (the lead routes; baseline: where does the missing container actually hurt?), then implement, then run the same epic as a real team. The friction delta decides whether the machinery earned its place and what (board? kickoff sugar?) comes next.

## Open questions

- Wake-budget shape: count wakes (simple, model-agnostic) or tokens (precise, needs trace folding at wake time)? Lean: wakes first.
- Does an `end` withdraw need to be explicit, or is "worked again after end" (as specced in §4) enough?
- `agnz team start` argument syntax vs. inline spec file — bikeshed at implementation time.
- Should the lead's hook block show intra-team traffic volume (messages exchanged) or only the end/budget counters? Lean: counters only — traffic is `show <team>` territory.
- Mixed-model teams (different profiles per member): allowed from day one, or fenced until the swap-thrashing question is measured?
