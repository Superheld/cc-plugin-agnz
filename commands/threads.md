---
description: List agnz threads in the current project workspace (read-only).
argument-hint: "list"
allowed-tools: Bash(node *)
model: haiku
---

Inspect agnz threads for the current project. Pure file read against
`<cwd>/.claude/agnz/threads/` — no MCP call needed, no parent context
burned on a thread-list pull.

## Sub-commands

- `list` — show every thread in the current workspace with its id,
  status, profile, agent role (if any), pending pause kind (if any),
  createdAt, and updatedAt. Sorted by createdAt descending.

## Instructions

The user invoked `/agnz:threads $ARGUMENTS`.

1. Parse `$ARGUMENTS` into a sub-command. Default to `list` if empty.
2. Run the companion CLI from the project root:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs threads list
   ```
3. Print the companion's JSON output verbatim. The shape is
   `{ cwd, count, threads: [{id, name, description, status, profile, agent, pending, createdAt, updatedAt}] }`.
4. If `count === 0`, mention that the workspace has no threads yet
   and point the user at `agent_start` or `/agnz:setup` if no
   profile is configured.

Do **not** run the command in the background — it finishes in
milliseconds and the user is waiting on the output.

## Examples

```
/agnz:threads                      → defaults to `list`
/agnz:threads list                 → show all threads in <cwd>/.claude/agnz/threads/
```
