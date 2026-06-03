# agnz evals

A fixture + scorecard harness for measuring **local-model quality per profile**
(ADR 0011 §5). It answers the product question agnz exists to answer: *which
local model is good enough for which agent role?*

This is **not** a unit test. It drives the real agent loop against a live local
model, so it needs a configured profile (`/agnz:setup`) and is run by hand —
not part of `node --test`. The pure scoring logic in `score.mjs` *is* unit-tested
(`tests/evals-score.test.mjs`).

## Running

```bash
node evals/run.mjs                        # active profile, all fixtures
node evals/run.mjs --profile lmstudio,ollama   # compare two profiles
node evals/run.mjs --fixture create-file  # a single fixture
node evals/run.mjs --json                 # machine-readable scorecard
```

Each run uses a throwaway temp workspace and an isolated thread index, so it
never touches your real `.claude/agnz/` state.

## What it measures

For every (fixture × profile) it records:

- **pass/fail** — a programmatic assertion on the *outcome* (resulting files,
  not the transcript wording).
- **quality metrics from the ADR 0011 trace** — turns to completion, total
  tokens, tool-error rate, and **repair rate** (how often the model emitted
  malformed tool-call JSON that had to be repaired — a strong proxy for
  tool-calling reliability).

The scorecard ranks profiles by pass rate, then by token cost. A model that
passes but flails (many turns, many repairs) ranks below one that passes
cleanly.

## Writing a fixture

Create `evals/fixtures/<name>/`:

- `fixture.json`
  ```json
  {
    "name": "<name>",
    "description": "one line",
    "prompt": "the instruction sent to the agent",
    "agent": {
      "name": "eval-...",
      "prompt": "system prompt for the agent",
      "tools": ["Read", "Edit", "Write", "LS", "Grep"],
      "maxTurns": 12
    }
  }
  ```
- `seed/` — optional; copied into the workspace before the run.
- `expect.mjs` — default-exports `async (cwd) => ({ pass, detail })`.

**Important:** the agent def's `tools` must list *every* tool the task needs.
Anything left to `ask` would pause forever in an unattended run, and the result
is recorded as `paused` (a fail). Do not use `AskUser` in eval agents.
