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
