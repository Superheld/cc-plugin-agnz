---
description: Configure local-model profiles for the agnt agent (list, add, remove, use, test).
argument-hint: "[list|add|remove|use|test] [name] [...]"
allowed-tools: Bash(node:*), AskUserQuestion
---

Profile management for the **agnt** plugin. Profiles are named `{baseUrl, apiKey, model, ...}` bundles stored in `plugins/agnt/data/profiles.json`. The agent uses the *active* profile when a thread is started without specifying one.

## Sub-commands

- `list` — show all configured profiles and the active one
- `add <name>` — add or replace a profile (interactive: will ask for baseUrl, model, apiKey)
- `remove <name>` — delete a profile
- `use <name>` — set the active profile
- `test [name]` — ping the profile's `baseUrl` to verify reachability

## Instructions

The user invoked `/agnt:setup $ARGUMENTS`.

1. Parse `$ARGUMENTS` into a sub-command and any positional args.
2. If no sub-command is given, default to `list`.
3. For `add`: if the user didn't supply all fields on the command line, use `AskUserQuestion` to collect: **profile name**, **baseUrl** (e.g. `http://localhost:1234/v1` for LM Studio, `http://localhost:11434/v1` for Ollama), **model** (e.g. `qwen2.5-coder-32b-instruct`), and optionally **apiKey**. Then call the companion CLI with all fields.
4. Run the companion CLI:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs setup <subcommand> [args...]
   ```
5. Print the companion's output verbatim. It will be JSON for structured responses or plain text for errors.

Do **not** run the command in the background — setup is interactive and finishes quickly.
