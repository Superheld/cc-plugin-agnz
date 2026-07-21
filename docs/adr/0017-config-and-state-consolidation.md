# ADR 0017 — Config and state consolidation

**Status:** Proposed (approved in direction by Bruce, 2026-07-21 — breaking change, fresh setup, no migration)

## Context

agnz state and configuration have accreted into many small files with dedicated
jobs, spread over two roots. The full census as of 0.17.0:

| File | Scope | Nature | Job |
|---|---|---|---|
| `~/.claude/agnz/profiles.json` | user | config | LLM endpoints (baseUrl, model, params) |
| `~/.claude/agnz/thread-index.json` | user | state (cache) | thread id → cwd resolver |
| `<cwd>/.claude/agnz/workspace.json` | project | **mixed** | name/cwd/timestamps (state) + `modelProfileMappings` (config) |
| `<cwd>/.claude/agnz/cursors/parent.json` | project | state | parent's read cursor into messages.jsonl |
| `<cwd>/.claude/agnz/cursors/parent-ws.json` | project | state | thread-set fingerprint for injection dedup |
| `<cwd>/.claude/agnz/messages.jsonl` | project | log | durable message log |
| `<cwd>/.claude/agnz/threads/<id>.{meta.json,jsonl,trace.jsonl}` | project | state/log | per-thread trio |

Three structural problems, observed in real use:

1. **The core question "which model serves this agent?" takes four hops across
   three scopes**: `agentDef.model` (agent file) → `workspace.json →
   modelProfileMappings` (project) → profile name → `profiles.json` (user) →
   endpoint. No single file answers it.
2. **`workspace.json` mixes state with config.** Its `cwd` field goes stale
   when a project moves (observed live: the agnz repo's own workspace.json
   still pointed at a pre-move path), and the staleness taints trust in the
   config fields sitting next to it.
3. **The thread index is a cache with cache-invalidation bugs.** It desyncs
   (the `reconcileWorkspace` self-heal exists solely to repair that), goes
   stale on project moves, and serves a lookup — id→cwd — that the CLI can
   almost always answer from its own cwd.

## Decision

### 1. One config schema, two layers, project wins (CC settings pattern)

```
~/.claude/agnz/config.json        # machine-level defaults
<cwd>/.claude/agnz/config.json    # optional project overrides, committable
```

Both files share one schema:

```jsonc
{
  "profiles": {
    "devstral": { "baseUrl": "http://…:11434/v1", "model": "devstral-2:96k", "temperature": 0.2 }
  },
  "mappings": { "_default": "devstral", "sonnet": "devstral" }
}
```

Loaded via a single `lib/config.mjs` with a deep merge (project keys override
user keys, per profile / per mapping entry). This follows Claude Code's own
`settings.json` / `.claude/settings.json` convention rather than inventing a
scheme. Typical setups need only the user file; a project that diverges
commits its override next to the code.

`profiles.json` dies; `modelProfileMappings` leaves `workspace.json`. The
`/agnz:setup` companion is rewritten against `lib/config.mjs` (writes the user
layer by default, `--project` for the override file) and gains an `info` view
that prints the **effective merged config with per-value origin** — the
four-hop chain rendered as one annotated line per agent/model.

### 2. `workspace.json` becomes pure state

Remaining shape:

```jsonc
{
  "schemaVersion": 2,
  "createdAt": …,
  "updatedAt": …,
  "parent": { "cursor": "m000042", "threadFingerprint": "…" }
}
```

- `cwd` and `name` are dropped — both derivable from the file's own location,
  and `cwd` is the field observed lying after a project move.
- The parent's delivery state moves in from `cursors/` (two files → one field),
  mirroring how each sub-agent already keeps its `inboxCursor` in its own
  thread meta: *every reader carries its read position in its own state file.*
  The `cursors/` directory disappears.
- Future board fields (ADR 0004) land here, as before.

Write discipline is unchanged: hooks advance `parent` only after stdout drain,
via the existing proc-lock + atomic-rename path — now on `workspace.json`.

### 3. The user-wide thread index is deleted

`thread-index.mjs` and `~/.claude/agnz/thread-index.json` go away. Resolution
becomes cwd-scoped: every verb resolves ids/names against
`<cwd>/.claude/agnz/threads/` (plus explicit `--cwd` for the rare
cross-project call — the flag already exists). `reconcileWorkspace` shrinks to
a plain dir scan (it *is* the source of truth now); the ghost-thread repair
machinery and the index desync bug class disappear with the cache.

### 4. Breaking, no migration

Pre-1.0 and single-digit user count: old layouts are **not** converted. On
first run against an old workspace, agnz prints one clear error naming this
ADR and the fresh-setup path (`/agnz:setup`). Version bump: minor (0.18.0).

## What deliberately stays

- **`messages.jsonl`** — an append-only log with per-reader cursors is the
  right shape for multi-process communication; it survives thread deletion by
  design (history outlives participants).
- **Transcript/trace split per thread** — model-facing history and
  observability have different readers and rewrite cadences; merging them
  would make every reader parse the other's records.
- **Agent defs & skills in CC-standard locations** — intentional sharing with
  Claude Code (ADR 0003); not agnz-private config.

## Also in scope (cheap wins bundled with the rebuild)

- `systemPromptSnapshot` moves out of thread meta into `threads/<id>.system.txt`,
  written once — meta rewrites shrink to ~25 % of today's bytes and `show`/
  hooks stop filtering it.
- (`remove` verb and uniform `name|id` addressing already landed pre-ADR.)

## Out of scope / deferred

- Per-thread subdirectories (`threads/<id>/…`) — cosmetic, touches every
  reader; revisit if the flat dir still hurts after this ADR.
- messages.jsonl rotation/compaction — not yet a real problem.

## Consequences

- File census: user root 2 → 1, project file kinds 6 → 4 (+1 optional
  config); every surviving file has exactly one nature (config / state / log /
  thread).
- `agnz send <id>` from an unrelated cwd now requires `--cwd` — accepted; the
  parent always runs in-project.
- Readers to touch: `orchestrate.resolveProfile`, `profiles.mjs` (absorbed
  into `config.mjs`), `workspace-store.mjs` (workspace shape, snapshot file),
  `threads.mjs` (index removal), `bin/agnz.mjs`, both hook scripts (cursor
  location), `skills/agnz-setup` (rewrite), `inspect.sh`, tests throughout.
