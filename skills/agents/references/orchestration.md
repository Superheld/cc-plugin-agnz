# agnz orchestration — when and how to delegate

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

Check whether the project has agent definitions:

```
Glob("<cwd>/.claude/agents/*.md")
```

Read the `description` field in each file's frontmatter. Pick the agent whose description best matches the task — a `researcher` for read/investigate work, an `editor` for write/refactor tasks. If no definitions exist, omit the `agent` parameter and the sub-agent runs with a generic prompt.

## Writing a good task brief

Write the message to `agent_send` as if briefing a capable colleague who cannot ask follow-up questions:

- What to do (concrete action, not "look into")
- What to produce (a summary, a list, a patch, a file path)
- Any constraints (don't touch X, output format Y)
- Where to start (entry-point file or directory if known)

**Too vague:** "Look into the auth module."
**Good:** "Summarise how session tokens are created and validated. Focus on `lib/auth/`. Produce a 3-paragraph summary: what creates a token, what validates it, what expires it."

## Handling outcomes

The return value of `agent_send` / `agent_wait` has a `content` field when `status: "final"`. Use that directly — do **not** re-read the transcript unless you need detail the summary omitted.

If `status: "max_turns"`, read the last few lines of the transcript:
```
Read <cwd>/.claude/agnz/threads/<id>.jsonl  (last ~20 lines)
```
Then either re-send with a continuation message or handle what was completed so far.

## Handling pauses

**Approval pause** (`kind: "approval"`): a gated tool wants to run. Inspect the tool and arguments in the return value, then:
- `agent_approve({ thread_id, decision: "allow" })` — allow once
- `agent_approve({ thread_id, decision: "allow", persist: true })` — allow for the rest of the thread
- `agent_approve({ thread_id, decision: "deny" })` — deny

**Question pause** (`kind: "question"`): the sub-agent called `AskUser`. Read the question in the return value and call:
- `agent_answer({ thread_id, answer: "<your answer>" })`

## Parallel runs

```
agent_start A → thread_A
agent_start B → thread_B
agent_send(A, task, detach: true)   // returns immediately
agent_send(B, task, detach: true)   // returns immediately
agent_wait(A) → outcome_A
agent_wait(B) → outcome_B
```

Both threads run concurrently via Node's event loop. Handle pauses for each independently — a pause on A does not block B.
