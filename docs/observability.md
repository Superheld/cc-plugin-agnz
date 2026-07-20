# Observability & evaluation

How to see what your local-model agents are doing, what they cost, and whether
a given model is good enough for a given role. Everything here is file-based and
zero-dependency, consistent with the rest of the plugin. The design is captured
in [ADR 0011](./adr/0011-observability-and-evaluation.md); this page is the
practical guide.

There are three things you can do:

1. **Inspect** a thread's runtime trace (turns, tokens, latency, tool outcomes).
2. **Monitor** active threads' spend without reading files — it's injected into
   Claude's context.
3. **Evaluate** a model/profile against fixtures to compare quality.

---

## 1. The runtime trace

Every thread writes an append-only trace alongside its transcript:

```
<cwd>/.claude/agnz/threads/<thread-id>.trace.jsonl
```

One JSON object per line, each stamped with `ts`. Event types:

| `type` | Emitted | Key fields |
|---|---|---|
| `thread_start` | once, first run | `agent`, `model`, `profile`, `maxTurns`, `tools[]`, `systemPrompt` |
| `turn_start` | before every LLM call | `turn` |
| `llm_call` | around each model call | `latencyMs`, `finishReason`, `usage{prompt,completion,total}` |
| `tool_call` | around each tool dispatch | `name`, `latencyMs`, `outcome` (`ok`/`error`/`denied`) |
| `repair` | malformed tool-call JSON repaired | `tool`, `recovered` (bool) |
| `pause` | approval/question pause | `kind`, `tool` |
| `thread_end` | terminal state | `reason` (`final`/`max_turns`/`error`/`stopped`), `turns`, `totals` |

Tracing is always fire-and-forget — a trace write failure never crashes or
slows the agent loop. The trace file accumulates across resumes, so it is the
authoritative full history of a thread.

The field names are OpenTelemetry-span-mappable (`ts` = span start, `latencyMs`
= duration, `outcome`/`reason` = status, `type` = span name). An opt-in OTLP
exporter can be added later as a pure reader of these files without touching the
loop — that is deliberately not built yet (ADR 0011 §6).

## 2. Reading stats

`lib/trace-stats.mjs` folds the trace into a summary. Re-aggregating the file is
more accurate than any single run's `thread_end.totals`, because it spans every
resume.

```bash
# workspace-wide totals + per-model breakdown (cwd = current project)
node ${CLAUDE_PLUGIN_ROOT}/lib/trace-stats.mjs

# one thread, detailed
node ${CLAUDE_PLUGIN_ROOT}/lib/trace-stats.mjs <thread-id>

# machine-readable
node ${CLAUDE_PLUGIN_ROOT}/lib/trace-stats.mjs <thread-id> --json
```

Or via the `agnz-threads` skill's terminal helper (needs `jq` + `node`):

```bash
bash skills/agnz-threads/scripts/inspect.sh stats        # workspace totals
bash skills/agnz-threads/scripts/inspect.sh <id-prefix>  # meta + stats + transcript
```

Example workspace view:

```
THREAD    AGENT         STATUS               TURNS    TOKENS   TOOLS
aaaa1111  dev           final                    6       4231       4
totals:   1 threads · 6 llm calls · 4231 tokens · 4 tool calls (0 err) · 1 repairs · 3.2s llm time
by model:
  devstral: 1 threads, 6 calls, 4231 tokens
```

## 3. Monitoring from the parent

You don't have to read files to know what's running. The `SessionStart` and
`UserPromptSubmit` hooks inject a compact workspace summary into Claude's
context, including a trace-derived spend line per active thread:

```
[agnz] workspace "demo-proj"
threads (2 active):
  dev:1a2b3c4d — running · 5 turns · 1,234 tok
  reviewer:9f8e7d6c — idle · 12 turns · 3,456 tok
```

The hooks are self-contained and a fast no-op in projects without an agnz
workspace. `UserPromptSubmit` only re-injects the summary when thread state
changed; unread `to:parent` messages are always injected. Urgent events
(completion, error, pause, max-turns) additionally fire an OS notification.

## 4. Testing

The loop, sandbox, mailbox, trace, and stats are covered by `node:test`:

```bash
node --test tests/
```

Loop tests need no live model: the LLM client is injectable via `ctx.chat`, and
`tests/_fake-llm.mjs` provides a scripted fake plus `toolCall`/`toolCalls`/
`finalMessage` builders. Coverage includes:

| File | Covers |
|---|---|
| `tests/sandbox.test.mjs` | path-escape + symlink-escape refusal, the three permission decisions |
| `tests/loop-resume.test.mjs` | approval allow/deny, question answer, multi-call leftover-drain, error propagation |
| `tests/mailbox.test.mjs` | mail delivery, self/other skip, cursor advance |
| `tests/loop-trace.test.mjs` | the full trace event set per run (final + max_turns) |
| `tests/trace-stats.test.mjs` | the stats fold + workspace rollup |
| `tests/hooks.test.mjs` | the spend fold + thread formatter |
| `tests/evals-score.test.mjs` | the eval scorecard |

> One pre-existing failure in `tests/workspace-store.test.mjs` expects an
> `items: []` field that ADR 0004 (board) has not added yet — unrelated to
> observability.

## 5. Evaluating local models

The `evals/` harness answers the product question: *which local model is good
enough for which agent role?* It drives the real loop against a live model, so
it is **not** part of `node --test` — run it by hand.

```bash
node evals/run.mjs                            # active profile, all fixtures
node evals/run.mjs --profile lmstudio,ollama  # compare two profiles
node evals/run.mjs --fixture create-file      # one fixture
node evals/run.mjs --json                      # machine-readable scorecard
```

Each run uses a throwaway workspace and isolated thread index — it never touches
your real `.claude/agnz/` state. For every (fixture × profile) it records a
pass/fail from a programmatic assertion on the *outcome* (resulting files, not
transcript wording), plus quality metrics pulled from the trace: turns, tokens,
tool-error rate, and **repair rate** (how often the model emitted malformed
tool-call JSON — a strong proxy for tool-calling reliability). Profiles are
ranked by pass rate, then by token cost.

### Writing a fixture

Create `evals/fixtures/<name>/`:

- `fixture.json` — `{ name, description, prompt, agent: { name, prompt, tools, maxTurns } }`
- `seed/` — optional files copied into the workspace before the run
- `expect.mjs` — `export default async (cwd) => ({ pass, detail })`

The agent def's `tools` must list **every** tool the task needs — anything left
to `ask` would pause forever unattended (recorded as `paused`). Don't use
`AskUser` in eval agents. See `evals/README.md` and the shipped `create-file` /
`edit-rename` fixtures for working examples.
