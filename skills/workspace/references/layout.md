# agnz workspace — full reference

Companion to [SKILL.md](SKILL.md). Read this when the quick version did not cover the case.

## Full user-wide layout

```
~/.claude/agnz/
├── profiles.json        ← named {baseUrl, apiKey, model, temperature, defaultPolicy, ...} bundles
└── thread-index.json    ← {threadId → cwd} so MCP tools can resolve a thread back to its project
```

`$AGNZ_DATA_DIR` overrides this root.

## Full per-project layout

```
<cwd>/.claude/agnz/
├── workspace.json       ← shared metadata + modelProfileMappings (see below)
├── messages.jsonl       ← durable append-only message log (ADR 0002), monotonic `m000001` ids
├── cursors/
│   └── parent.json      ← last message id the parent has seen (advanced by the hooks)
└── threads/
    ├── <thread-id>.meta.json    ← status, pending, policy, cwd, inboxCursor, agentDef snapshot
    └── <thread-id>.jsonl        ← append-only transcript (user / assistant / tool)
```

Agent definition files live at `<cwd>/.claude/agents/` (project-local) and `~/.claude/agents/` (user-wide) — not inside the `agnz/` subtree.

## workspace.json shape

```json
{
  "schemaVersion": 1,
  "name": "my-project",
  "cwd": "/path/to/project",
  "createdAt": 0,
  "updatedAt": 0,
  "members": ["<thread-id>", "..."],
  "modelProfileMappings": {
    "inherit":  "lmstudio",
    "opus":     "lmstudio",
    "sonnet":   "lmstudio",
    "haiku":    "lmstudio",
    "_default": "lmstudio"
  }
}
```

`modelProfileMappings` maps CC model identifiers to profile names. When an agent def says `model: inherit` (or `model: sonnet` etc.), agnz looks up the profile here instead of treating the model string as a profile name directly.

- `inherit` — CC default; use the project's primary local model
- `opus` / `sonnet` / `haiku` — CC model tiers; map to appropriate profiles when you have multiple local models of different sizes
- `_default` — fallback for any unmapped identifier

If `modelProfileMappings` is absent or a key is not found, the model string is used as a profile name directly (backwards compat).

## profiles.json shape

```json
{
  "version": 1,
  "activeProfile": "lmstudio-devstral",
  "profiles": {
    "lmstudio-devstral": {
      "baseUrl": "http://localhost:1234/v1",
      "apiKey": null,
      "model": "mistralai/devstral-small-2-2512",
      "temperature": 0.2,
      "maxTokens": null,
      "maxTurns": 20,
      "llmTimeoutMs": null
    }
  }
}
```

| Field | Required | Default | Notes |
|---|---|---|---|
| `baseUrl` | yes | — | OpenAI-compatible endpoint, e.g. `http://localhost:1234/v1` |
| `model` | yes | — | Model identifier as the server expects it |
| `apiKey` | no | `null` | LM Studio / Ollama ignore it; required for OpenRouter etc. |
| `temperature` | no | `0.2` | 0.0–2.0; 0.1–0.3 works best for coding sub-agents |
| `maxTokens` | no | `null` | Max tokens in the completion; `null` = server default |
| `maxTurns` | no | `20` | Hard ceiling on the agent loop before it stops with `max_turns` |
| `llmTimeoutMs` | no | `null` | Request timeout in milliseconds; `null` = 600 000 ms (10 min). Increase for very slow models (large model on CPU, long context). |

## thread meta shape

```json
{
  "id": "ce63f17a-...",
  "cwd": "/abs/path/to/project",
  "profile": "lmstudio-devstral",
  "policy": { "Read": "allow", "Edit": "deny", ... },
  "systemPrompt": null,
  "agentDef": { "name": "researcher", "body": "...", "disallowedTools": [...], ... } | null,
  "status": "idle" | "running" | "awaiting_input" | "stopped" | "error",
  "inboxCursor": "m000042" | null,
  "createdAt": 1775724539724,
  "updatedAt": 1775724612100,
  "error": null | { "message": "...", "stack": "..." },
  "pending": null | { "toolCallId": "...", "kind": "approval"|"question", ... }
}
```

When `status === "awaiting_input"`, `pending` is populated and the thread is waiting for the parent to resolve it via `agent_approve` (if `kind === "approval"`) or `agent_answer` (if `kind === "question"`). See the `agents` skill for the resolution flow.

## messages.jsonl shape

Each line is one message. Ids are monotonic strings like `m000001` — lexical sort = chronological sort. Fields:

```json
{
  "id": "m000042",
  "from": "researcher",
  "to": "parent" | "editor" | ["researcher", "editor"] | "*",
  "kind": "say" | "question" | "answer" | "handoff" | "status" | "error" | "directive",
  "text": "...",
  "ref": "m000041" | undefined,
  "urgent": true | undefined,
  "item_id": "..." | undefined,
  "at": "2026-04-09T01:42:05.022Z"
}
```

Sub-agents read their mailbox automatically at the top of every turn (messages addressed to them get injected as synthetic user messages and the thread's `inboxCursor` is advanced). The parent gets unread mail via the opt-in `UserPromptSubmit` / `SessionStart` hooks — see the top-level plugin readme for how to enable them.

## /agnz:setup — sub-commands in detail

- `list` — prints the profiles table and marks the active one. No args.
- `add <name> [baseUrl] [model] [apiKey]` — interactive when fields are omitted. Will ask you for each missing field via `AskUserQuestion`.
- `remove <name>` — deletes the named profile. If it was active, `activeProfile` is set back to `null`.
- `use <name>` — set the active profile. Error if the name does not exist.
- `test [name]` — ping the profile's `baseUrl` (defaults to active). Lists models the endpoint reports and flags whether the profile's `model` appears in that list.

## Troubleshooting

**`fetch failed` or connection refused on first send.** The local runtime (LM Studio, Ollama) isn't running, or is serving on a different port. Start the server, then retry. `agent_send` does NOT retry automatically.

**Thread wedged with a jinja/template error about alternation.** The previous send failed mid-turn and left the transcript with two consecutive user messages (or a tool-result with no matching tool call). The thread is unrecoverable today — stop it and start a fresh one. This is a known rough edge; the agent loop should not persist the user message until the LLM call succeeds.

**`no profile named '<x>'`.** The thread's profile was renamed or removed out from under a running thread, or the profile was written directly to `profiles.json` with a typo. Run `/agnz:setup list` to see what's actually there.

**Stale `defaultPolicy` after plugin upgrade.** Profiles are loaded as-is from disk — new tools added to the plugin don't retroactively appear in old profiles. Recreate the profile (`/agnz:setup remove` then `add`) to pick up the new default tool policy.

**Cache collision after plugin reinstall.** Claude Code caches plugin files per version under `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`. The running MCP process can outlive a `/reload-plugins` — if behavior seems frozen, manually kill the `node mcp/server.mjs` process and let CC respawn it.
