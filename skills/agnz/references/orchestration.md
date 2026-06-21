# agnz orchestration — when and how to delegate

All invocations are CLI calls via Bash: `agnz <verb> …`.

## Thread reuse — resume before recreating

Every thread has a name, a purpose, and a transcript. Check existing threads first:

```bash
agnz list          # (or the /agnz:threads skill)
```

`send <name>` **reuses** the most recent live thread of that name — the sub-agent picks up where it left off with all its context:

```bash
agnz send researcher-1 "Continue: now write the tests."
```

Only `start` a new thread when the task or role is genuinely different. Threads in `error` state cannot be resumed — `start` fresh (their transcript is preserved for inspection).

## The routing decision

**Delegate to a sub-agent when:**
- Frontier quality is not needed — local models handle read-heavy investigation, mechanical edits, and summarisation well
- The output will be reviewed before use — a reviewer catches mistakes, so local-model quality is sufficient
- Reading and summarising more than ~5 files — intermediate reads stay out of parent context
- Mechanical work: rename X everywhere, find all usages of Y, apply a pattern across many files
- Parallel work — two independent investigations running simultaneously
- The task is self-contained enough to brief in one paragraph

**Do it yourself when:**
- The task requires reasoning quality only a frontier model can provide
- One or two tool calls is all it takes — spawning has overhead
- The task needs real-time judgment or user interaction mid-way
- The full reasoning chain needs to stay in parent context
- No profile is configured (`~/.claude/agnz/profiles.json` missing or empty)

## Picking an agent

Bundled agents (`dev`, `researcher`, `reviewer`, `general`) work everywhere. For project roles, check `<cwd>/.claude/agents/*.md` and read each `description` to match the task — a `researcher` for read/investigate work, a `dev` for write/refactor tasks. With no fitting def, pass `--inline "<frontmatter>"` for an ad-hoc role.

## Writing a good task brief

Write the task you pass to `agnz start`/`send` as if briefing a capable colleague who cannot ask follow-up questions:

- What to do (concrete action, not "look into")
- What to produce (a summary, a list, a patch, a file path)
- Any constraints (don't touch X, output format Y)
- Where to start (entry-point file or directory if known)

**Too vague:** "Look into the auth module."
**Good:** "Summarise how session tokens are created and validated. Focus on `lib/auth/`. Produce a 3-paragraph summary: what creates a token, what validates it, what expires it."

## Handling outcomes

With `--wait`, the call returns a `content` field when `status: "final"` — use that directly, don't re-read the transcript unless you need detail the summary omitted. Detached (default): the final answer arrives via the message hook at your next prompt; `agnz show <id>` peeks any time.

If `status: "max_turns"`, the work so far is persisted — `agnz send <id> "continue"` to resume, or read the transcript tail (`<cwd>/.claude/agnz/threads/<id>.jsonl`) for what was done.

## Handling pauses

**Approval pause** (`kind: "approval"`): a gated tool wants to run. Inspect the pending tool/args (`agnz show <id>` or the meta), then:
- `agnz approve <id> allow` — allow once
- `agnz approve <id> allow --persist` — allow this tool for the rest of the run
- `agnz approve <id> deny` — deny (injected as the tool result; the agent may try another way)

**Question pause** (`kind: "question"`): the sub-agent called `AskUser`:
- `agnz answer <id> "<your answer>"`

**Runaway**: `agnz interrupt <id> ["directive"]` aborts the current step and leaves the thread resumable.

## Parallel runs

```bash
agnz start auth    "Investigate how auth works"    --agent researcher
agnz start billing "Investigate how billing works" --agent researcher
# Both run as separate detached processes; results arrive via the hook at the next prompt.
agnz list          # see status/spend of both; a pause on one doesn't block the other
```

Each run is its own OS process — genuine parallelism, nothing resident between runs.
