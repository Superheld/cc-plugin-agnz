---
description: Configure local-model profiles for the agnz agent (list, add, remove, use, test).
argument-hint: "list | add <name> | remove <name> | use <name> | test [name]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs:*), AskUserQuestion
model: haiku
---

Profile management for the **agnz** plugin. Profiles are named `{baseUrl, apiKey, model, ...}` bundles stored in `~/.claude/agnz/profiles.json` (override with `$AGNZ_DATA_DIR`). The agent uses the *active* profile when a thread is started without specifying one.

## Sub-commands

- `list` — show all configured profiles and the active one
- `add <name>` — add or replace a profile (interactive: will ask for baseUrl, model, apiKey)
- `remove <name>` — delete a profile
- `use <name>` — set the active profile
- `test [name]` — ping the profile's `baseUrl` to verify reachability

## Instructions

The user invoked `/agnz:setup $ARGUMENTS`.

1. Parse `$ARGUMENTS` into a sub-command and any positional args.
2. If no sub-command is given, default to `list`.
3. For `add`: if the user didn't supply all fields on the command line, use `AskUserQuestion` to collect: **profile name**, **baseUrl** (e.g. `http://localhost:1234/v1` for LM Studio, `http://localhost:11434/v1` for Ollama), **model** (e.g. `qwen2.5-coder-32b-instruct`), and optionally **apiKey**. Then call the companion CLI with all fields.
4. Run the companion CLI:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs setup <subcommand> [args...]
   ```
5. Print the companion's output verbatim. It will be JSON for structured responses or plain text for errors.

Do **not** run the command in the background — setup is interactive and finishes quickly.

## Examples

```
/agnz:setup                               → defaults to `list`
/agnz:setup list                          → show profiles + active
/agnz:setup add lmstudio-devstral         → interactive add (asks baseUrl, model, apiKey)
/agnz:setup use lmstudio-devstral         → set active profile
/agnz:setup test                          → ping the active profile
/agnz:setup test lmstudio-devstral        → ping a specific profile
/agnz:setup remove old-profile            → delete a profile
```
