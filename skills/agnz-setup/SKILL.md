---
name: agnz-setup
description: Configure and inspect the agnz plugin — profiles, model→profile mappings, and current status. This skill should be used when the user asks to "add a profile", "set up agnz", "configure lmstudio", "show agnz status", "what profiles exist", "map sonnet to a local model", or anything about agnz configuration and setup.
argument-hint: "list | add <name> | remove <name> | use <name> | test [name] | mapping list|set|remove | info"
allowed-tools: Bash(node:*), AskUserQuestion
model: haiku
---

Configuration and status for the **agnz** plugin. Three things live here:

1. **Profiles** — named `{baseUrl, apiKey, model, ...}` bundles in the two-layer `config.json` (ADR 0017): `~/.claude/agnz/config.json` holds machine defaults, `<cwd>/.claude/agnz/config.json` optional project overrides (pass `--project` on write commands; project wins per entry).
2. **Model→profile mappings** — per-project table in `<cwd>/.claude/agnz/workspace.json`. Maps CC model names to profile names so agent defs stay CC-compatible.
3. **Info** — current state: version, data paths, active profile, per-project agents/skills/threads.

## Sub-commands

**Profiles:**
- `list` — show all profiles and the active one (default when no args given)
- `add <name>` — add or replace a profile (interactive)
- `remove <name>` — delete a profile
- `use <name>` — set the active profile
- `test [name]` — ping the profile's `baseUrl` to verify reachability

**Mappings:**
- `mapping list` — show the model→profile table for the current project
- `mapping set <model> <profile>` — add or update one entry (e.g. `sonnet lmstudio`)
- `mapping remove <model>` — delete one entry

**Info:**
- `info` — print version, data paths, active profile, and per-project agents/skills/threads

## How mappings work

When `agnz start` resolves a profile it looks up `agentDef.model` in the mapping table. `_default` is the fallback for any unmatched model. Without a mapping the model identifier is used directly as a profile name.

**Typical project setup — all agents run locally:**
```
/agnz:setup mapping set _default lmstudio
/agnz:setup mapping set inherit  lmstudio
/agnz:setup mapping set sonnet   lmstudio
```
After this, any agent def using `model: sonnet`, `model: inherit`, or no model routes to `lmstudio`. No agent files need editing.

**Multiple local models:**
```
/agnz:setup add devstral     # fast, small — research tasks
/agnz:setup add qwen-coder   # large — editing tasks
/agnz:setup mapping set inherit devstral
/agnz:setup mapping set sonnet  qwen-coder
```

## Profile fields

| Field | Required | Default | Notes |
|---|---|---|---|
| `baseUrl` | yes | — | OpenAI-compatible endpoint, e.g. `http://localhost:1234/v1` |
| `model` | yes | — | Model id as the server expects it, e.g. `mistralai/devstral-small-2-2512` |
| `apiKey` | no | `null` | Bearer token; LM Studio / Ollama don't require one |
| `temperature` | no | `0.2` | Sampling temperature |
| `maxTokens` | no | `null` | Max tokens per response; `null` = server default |
| `maxTurns` | no | `20` | Max loop turns before the thread pauses |
| `llmTimeoutMs` | no | `null` (= 10 min) | Increase for large/slow models on CPU |
| `contextWindow` | no | `null` | The model's context window in tokens (the API doesn't expose it). Setting it enables context compaction: near the limit the agent summarizes its session and continues with a fresh context |
| `compactThreshold` | no | `0.9` | Fraction of `contextWindow` at which compaction fires |

## Fresh project setup

```
# 1. Add a profile (interactive)
/agnz:setup add lmstudio

# 2. Verify reachability
/agnz:setup test lmstudio

# 3. Map CC model identifiers to the profile
/agnz:setup mapping set _default lmstudio
/agnz:setup mapping set inherit  lmstudio
/agnz:setup mapping set sonnet   lmstudio

# 4. Confirm everything
/agnz:setup info
```

## Instructions

The user invoked `/agnz:setup $ARGUMENTS`.

1. Parse `$ARGUMENTS` into a sub-command and positional args.
2. If no sub-command is given, default to `list`.
3. For `add`: collect missing fields via `AskUserQuestion` — **profile name**, **baseUrl**, **model**, optionally **apiKey** and **llmTimeoutMs**.
4. For `info`: run `node ${SKILL_BASE_DIR}/scripts/companion.mjs info`
5. For all other sub-commands: run `node ${SKILL_BASE_DIR}/scripts/companion.mjs setup <subcommand> [args...]`
6. Print the companion's output verbatim.

Do **not** run in the background — finishes in milliseconds.

## Examples

```
/agnz:setup                                        → list profiles
/agnz:setup info                                   → show full status
/agnz:setup add lmstudio                           → interactive add
/agnz:setup use lmstudio                           → set active profile
/agnz:setup test                                   → ping active profile
/agnz:setup remove old-profile                     → delete profile
/agnz:setup mapping list                           → show model→profile table
/agnz:setup mapping set sonnet lmstudio            → map sonnet → lmstudio
/agnz:setup mapping set _default lmstudio          → set fallback
/agnz:setup mapping remove opus                    → remove one entry
```
