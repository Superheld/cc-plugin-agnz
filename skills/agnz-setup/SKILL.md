---
name: agnz-setup
description: Configure local-model profiles and model→profile mappings for the agnz agent (list, add, remove, use, test, mapping).
argument-hint: "list | add <name> | remove <name> | use <name> | test [name] | mapping list|set|remove"
allowed-tools: Bash(node *) AskUserQuestion
model: haiku
---

Configuration for the **agnz** plugin. Two things live here:

1. **Profiles** — named `{baseUrl, apiKey, model, ...}` bundles stored in `~/.claude/agnz/profiles.json`. The active profile is the default for new agent threads.
2. **Model→profile mappings** — per-project table in `<cwd>/.claude/agnz/workspace.json`. Maps CC model names (`sonnet`, `opus`, `inherit`, `_default`) to profile names. This lets agent definition files stay CC-compatible (`model: sonnet`) while routing to a local model in agnz.

## Profile sub-commands

- `list` — show all profiles and the active one
- `add <name>` — add or replace a profile (interactive)
- `remove <name>` — delete a profile
- `use <name>` — set the active profile
- `test [name]` — ping the profile's `baseUrl` to verify reachability

## Mapping sub-commands

- `mapping list` — show the model→profile table for the current project
- `mapping set <model> <profile>` — add or update one entry (e.g. `sonnet lmstudio`)
- `mapping remove <model>` — delete one entry

**How mappings work:** when `agent_start` resolves a profile, it first looks up the agent def's `model:` field in the mapping table. If found, it uses that profile. `_default` is the fallback for any unmatched model. Without a mapping the model identifier is used directly as a profile name.

**Typical setup for a project where all agents should run locally:**
```
/agnz:setup mapping set inherit lmstudio
/agnz:setup mapping set sonnet  lmstudio
/agnz:setup mapping set opus    lmstudio
/agnz:setup mapping set _default lmstudio
```
After this, any agent def with `model: sonnet` (or `model: inherit`, or no model) runs via the `lmstudio` profile — no changes to the agent files needed.

## Profile fields

All fields stored in `~/.claude/agnz/profiles.json`:

| Field | Required | Default | Notes |
|---|---|---|---|
| `baseUrl` | yes | — | OpenAI-compatible endpoint, e.g. `http://localhost:1234/v1` |
| `model` | yes | — | Model identifier as the server expects it, e.g. `mistralai/devstral-small-2-2512` |
| `apiKey` | no | `null` | Bearer token; LM Studio / Ollama don't require one |
| `temperature` | no | `0.2` | Sampling temperature |
| `maxTokens` | no | `null` | Max tokens per response; `null` = server default |
| `maxTurns` | no | `20` | Max loop turns before the thread pauses |
| `llmTimeoutMs` | no | `null` (= 10 min) | Increase for large/slow models on CPU |

## Fresh project setup

Complete flow from zero to first agent run:

```
# 1. Add a profile (interactive — will ask for baseUrl + model)
/agnz:setup add lmstudio

# 2. Verify reachability
/agnz:setup test lmstudio

# 3. Map CC model identifiers → this profile
#    (so agent defs with model: sonnet/inherit/etc. route to your local model)
/agnz:setup mapping set _default lmstudio
/agnz:setup mapping set inherit  lmstudio
/agnz:setup mapping set sonnet   lmstudio

# 4. Confirm the full picture
/agnz:setup
/agnz:setup mapping list
```

After step 3, any agent def — whether it uses `model: sonnet`, `model: inherit`, or omits `model` entirely — will resolve to `lmstudio`. No agent files need editing.

**Multiple local models:** create one profile per endpoint/model, then point specific CC model names at each:
```
/agnz:setup add devstral   # fast, small — for research tasks
/agnz:setup add qwen-coder # large — for editing tasks
/agnz:setup mapping set inherit devstral
/agnz:setup mapping set sonnet  qwen-coder
```

## Instructions

The user invoked `/agnz:setup $ARGUMENTS`.

1. Parse `$ARGUMENTS` into a sub-command and any positional args.
2. If no sub-command is given, default to `list`.
3. For `add`: if the user didn't supply all fields, use `AskUserQuestion` to collect: **profile name**, **baseUrl** (e.g. `http://localhost:1234/v1`), **model** (e.g. `mistralai/devstral-small-2-2512`), and optionally **apiKey**. Optional: **llmTimeoutMs** (increase for slow models). Then call the companion CLI.
4. Run the companion CLI:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs setup <subcommand> [args...]
   ```
5. Print the companion's output verbatim.

Do **not** run in the background — finishes in milliseconds.

## Examples

```
/agnz:setup                                        → list profiles
/agnz:setup add lmstudio                           → interactive add
/agnz:setup use lmstudio                           → set active profile
/agnz:setup test                                   → ping active profile
/agnz:setup remove old-profile                     → delete profile
/agnz:setup mapping list                           → show model→profile table
/agnz:setup mapping set sonnet lmstudio            → map sonnet → lmstudio
/agnz:setup mapping set _default lmstudio          → set fallback profile
/agnz:setup mapping remove opus                    → remove one entry
```
