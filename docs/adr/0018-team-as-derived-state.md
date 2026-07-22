# ADR 0018 — Team as derived state, mission as a message

- **Status:** Proposed (discussion draft — do not implement before Bruce and the lead have converged)
- **Date:** 2026-07-23
- **Relates to:** ADR 0002 (mailbox), ADR 0003 (agent definitions), ADR 0004 (board — deliberately still unbuilt), ADR 0012 (frozen prompt prefix)

## Context

agnz is architected for concurrent agents (detached OS processes, per-agent mailboxes, `SendMessage(to: <name>)`), but the agents are **mutually invisible**: no agent knows who else exists, what they specialise in, or what they are working on. The team layer exists mechanically and is absent experientially.

Three constraints shape the design, all from the 2026-07-23 discussion:

1. **Goals are epic-scoped, not project-scoped.** A team works on epic 1, then a new goal follows with epic 2 — same or different team. Anything stored in project config would be stale by construction. (This killed the first proposal: `team: {name, goal}` in `config.json`.)
2. **Solo use must stay frictionless.** "Wenn man mal nur nen Reviewer braucht" must not require creating, naming, or dissolving a team. Team-ness has to be a gradient, not a mode.
3. **Late joiners are normal.** Agents spawn at different times. Anything baked into the frozen system-prompt prefix (ADR 0012) describes the team as it was at *thread start* — a colleague spawned later would be invisible, a stopped one would linger. A prefix roster is stale by construction, same disease as (1) in a different organ.

Additionally, one hardware fact defuses the scheduling worry: when all agents use the **same local model**, the inference server serialises requests — N "parallel" agents interleave at the token level automatically. The server queue *is* the scheduler. Only agents wanting *different* models (swap thrashing) would ever need a real concurrency brake, and that stays unbuilt until it hurts.

## Decision (proposed)

**The team is not an object. The team is the set of live threads, and every piece of team context is *derived* at read time from state that already exists.**

The insight that makes the layer thin: nothing needs to be *managed*, because everything is already *there* —

| Team question | Existing source |
|---|---|
| Who exists? | live thread metas (`threads/*.meta.json`) |
| Who is specialised in what? | the agent def's `description` (ADR 0003) — that field *is* the specialisation text |
| Who works on what right now? | resume-card `task` + the `working:` live summary |
| How do I reach them? | thread name = mailbox address (ADR 0002) |

### 1. Roster injection at turn start (the one new mechanism)

`drainTopOfTurnContext` (which already injects inbox mail and one-time dir context) gains a third section, injected **only when at least one other live thread exists** — the solo case sees nothing, costs nothing:

```
Team — other agents in this workspace (address them with SendMessage):
- reviewer — checks changes before committing — awaiting_input
- tester — writes and runs the test suite — working: auth e2e tests
```

One line per colleague: `name — def-description first line — status/current task`. Derived fresh every turn, so late joiners appear, stopped agents vanish, and nothing can go stale. Deliberately **not** in the frozen prefix (constraint 3).

Delta-only injection (roster re-sent only when changed, mirroring the parent hook's fingerprint gate) is the cache-friendly refinement; first implementation may re-send when changed since the last turn, keyed by a roster fingerprint on the thread meta.

### 2. Mission is a message, not a field

The epic/goal is **not stored anywhere**. The lead writes it into the task messages it sends — it already does; a kickoff directive to each crew member ("Epic 2: rebuild the billing flow. You own X; reviewer owns Y") is the mission statement, and it lands in the transcript where it survives resumes. Text in the conversation is the most flexible carrier for something that changes per epic (constraint 1), and the lead — who owns the epic anyway — is its natural author.

### 3. Agent = named thread (the identity commitment)

The address-book discussion (2026-07-23) surfaced the underlying identity question: is an "agent" the def, the thread, or something that persists across threads? This ADR commits to the simplest coherent model:

**The name is the identity; the thread is its memory; the def is only the role (class, not instance).**

- "Reuse the agent" = resume its thread, with all accumulated context (`send <name>`).
- "Same role, fresh head" = a **new agent** with a new name (`dev-auth`, `dev-billing`) — not a second thread under the same name.
- Naming convention for the lead (skill guidance, not mechanism): **name = mission instance**. Mission continues → resume; new mission → new name. Sharing one name across parallel threads is the anti-pattern; `resolveTarget`'s most-recent-wins is the fallback, not the design.

The rejected-for-now alternative — **agent as a persistent identity across threads** (one `reviewer`, many conversations over time) — is deliberately out of scope: an identity that remembers nothing between threads is just a reused string, so this model is only honest with cross-thread memory underneath it. That is ADR 0008 (brain) territory, and the boundary is drawn here precisely so the messaging layer never half-implements a brain by accident.

### 4. Coordination stays hub-and-spoke

The lead orchestrates: assigns work, routes handoffs, decides sequencing. Agent-to-agent traffic is limited to what the mailbox already allows — questions, answers, status (`SendMessage(to: "reviewer", kind: "question", …)`), which the roster finally makes *usable* (you can only ask someone you know exists). **No agent-to-agent task delegation**: local models orchestrating each other is a failure multiplier, and it would bypass the approval model. Mesh coordination, if ever, is a separate ADR with dogfooding scars behind it.

## Considered and rejected

- **`team: {name, goal}` in project config** — rejected: epic-scoped vs. project-scoped mismatch (constraint 1); the file would lie the day epic 2 starts.
- **Team as a first-class object** (`agnz team start "epic" --agents dev,review,test`, shared prefix, joint teardown) — rejected *for now*: it's the thick layer — a lifecycle to manage, an awkward mismatch for solo use (constraint 2), and its one unique benefit (one-command crew spawn) is sugar the lead can replicate with three `start` calls. Revisit only if dogfooding shows kickoff boilerplate genuinely hurts.
- **Roster in the frozen system prompt** — rejected: stale by construction for late joiners/leavers (constraint 3); turn-start injection subsumes it. Two carriers for one fact would drift.
- **Pure hub without any a2a** — rejected: the mailbox exists, is tested, and a colleague-to-colleague question is strictly cheaper than routing the same question through the lead's context.

## Consequences

- Solo use is byte-identical to today (no roster section when no colleagues exist).
- The "team feeling" emerges from usage: spawn three agents and they can see and address each other; stop two and the third is simply alone again.
- No new files, no new verbs, no new lifecycle. The implementation surface is one function in `lib/loop.mjs` (+ a roster-fingerprint field on the thread meta for delta gating) and tests.
- The lead's side needs nothing: the hook block already lists all agents.

## Validation before/after building

Dogfood the smallest real crew — **dev → reviewer → test on the dashboard project** — orchestrated hub-and-spoke by the lead. Run it once *before* implementing the roster (baseline: where does mutual blindness actually hurt?) and once after. The friction log decides what, if anything, comes next (board? kickoff sugar? nothing?).

## Delivery to idle colleagues (the address book's honest gap)

Mailbox delivery happens at turn start — an idle agent has no next turn until something spawns it, so a question addressed to an idle colleague lies unread. Two answers were considered:

- **Auto-wake** (incoming a2a mail spawns the recipient's runner): rejected — agents would burn tokens on runs the lead never initiated, bypassing the control model. This is mesh coordination through the back door.
- **Lead-mediated wake** (chosen direction): the hook block surfaces unread a2a mail for idle recipients ("reviewer has 1 unread from dev — idle"); the lead decides whether to wake it. Hub-and-spoke consistent. The roster marks idle colleagues honestly: `reviewer — idle — replies when next started`.

The address book itself is context, never tool schema: dynamic names inside the `tools[]` payload would mutate the prompt every turn and break prefix caching (ADR 0012); the roster injection appends cache-safely instead.

## Open questions

- Should the roster line include the colleague's `ctx` weight so an agent can judge how loaded a colleague is? (Lean: no — that's the lead's concern.)
- Does `to: "*"` broadcast deserve a CLI verb for kickoffs? Caveat: broadcast mail only reaches agents at their next turn — an idle agent has no next turn until the lead sends to it, so a kickoff broadcast is weaker than it looks.
- Roster wording for paused colleagues (`awaiting_input` — worth telling an agent that its reviewer is stuck on an approval?).
- Should the lead-mediated wake be a one-keystroke affair (`agnz send reviewer ""` is awkward; maybe `send` with no message just wakes = drains the inbox)?
