# ADR 0009: Tool configuration — composing the tool set at agent init

- **Status:** Accepted
- **Date:** 2026-04-09
- **Updated:** 2026-04-11
- **Depends on:** [ADR 0003](./0003-agent-definitions.md), [ADR 0006](./0006-mcp-for-agents.md)

## Context

Today every sub-agent gets the same fixed tool set: `list_dir`, `read_file`, `grep`, `edit_file`, `write_file`, `bash`, `ask_user`, `send_message`. The agent definition's `tools:` map can restrict individual tools (via `deny`) or change their approval policy, but it cannot add new tools, remove tools entirely from the registry, or configure how a tool behaves.

This is limiting in two ways:

**1. The default set is too broad for specialised agents.** A read-only research agent carries `edit_file`, `write_file`, and `bash` in its tool schema — the LLM sees them and may attempt to use them even when the policy says `ask`. Every unnecessary tool adds noise and risk. A read-only agent should simply not have mutating tools in its schema at all.

**2. Tools need configuration, not just policy.** `bash` today has a hardcoded 30s timeout and 1 MiB output cap. A build agent might need 5 minutes for a `cargo build`. A linting agent might want bash restricted to a specific allowlist of commands. Policy (allow/ask/deny) controls *whether* a tool runs; configuration controls *how* it runs.

## Decision

### 1. Named tool presets in the agent definition

An agent definition may declare a `preset:` that selects a pre-built tool composition:

```yaml
preset: read-only       # list_dir, read_file, grep only — no writes, no shell
preset: standard        # all built-ins (today's default)
preset: full            # standard + bash auto-allowed
```

Presets are the fast path. The agent def's `tools:` map then layers on top of the preset — adding `deny` for tools the role should never touch, or `allow` for tools the preset would normally `ask` about.

**Built-in presets:**

| Preset | Tools included | Default policies |
|---|---|---|
| `read-only` | `list_dir`, `read_file`, `grep`, `ask_user`, `send_message`, `use_skill` | all `allow` |
| `standard` | all of the above + `edit_file`, `write_file`, `bash` | writes `ask`, bash `ask` |
| `full` | same as `standard` | writes `allow`, bash `allow` |

The default (no `preset:`) is `standard`, matching today's behaviour exactly.

### 2. Per-tool configuration in the agent definition

An agent definition may pass configuration to specific tools under a `tool_config:` key:

```yaml
tool_config:
  bash:
    timeout: 300000      # 5 minutes (ms)
    maxOutput: 10485760  # 10 MiB
    allowedCommands:     # if set, only these prefixes are permitted
      - cargo
      - npm test
      - make
  read_file:
    maxSize: 524288      # 0.5 MiB per file read
```

`tool_config:` entries are passed to the tool at construction time. Tools that do not understand a config key ignore it — forward compatibility. Tools that require a key that is missing use their compiled-in defaults.

The `allowedCommands` filter on `bash` is the most important: it lets a CI agent run `npm test` without being able to `rm -rf` anything. The filter is prefix-based (the command string must start with one of the listed prefixes after trimming) — simple, auditable, no regex injection risk.

### 3. Bash command allowlists (dynamic approvals)

Every Bash call that would otherwise require approval (`ask` policy) checks a set of command lists before surfacing a pause. These lists live in `workspace.json` under a per-agent namespace, with a `_generic_` fallback for threads started without an agent name.

**Storage in `<cwd>/.claude/agnz/workspace.json`:**

```json
{
  "agentCommands": {
    "_generic_": {
      "allow": ["git status", "npm test"],
      "deny": []
    },
    "researcher": {
      "allow": ["grep -r", "find . -name"],
      "deny": ["rm -rf", "dd if="]
    },
    "editor": {
      "allow": [],
      "deny": []
    }
  }
}
```

**Lifetime semantics:**

All entries in `workspace.json` are persistent — they survive MCP server restarts and CC sessions. There is no session-scoped storage (the MCP server is stateless between invocations; threads do not persist their command decisions across restarts).

**Resolution order for every Bash call:**

1. `deny` matches → immediately denied
2. `allow` matches → immediately executed
3. no match → pause with approval request

**Approval resolution:**

When the parent calls `agent_approve(thread_id, tool_call_id, decision)`:

- `decision=allow` → command added to `allow` for the current agent
- `decision=deny` → command added to `deny` for the current agent

The agent name used for storage is `thread.agentDef?.name ?? "_generic_"`. Lists are always stored in workspace.json — no in-memory caching. The agent definition may also declare static `allowedCommands` via `tool_config:` (prefix-based); dynamic approvals layer on top of that.

### 4. Tool set at `agent_start` (inline override)

For one-off customisation without an agent definition file, `agent_start` accepts a `tools` parameter that mirrors the agent def `tools:` map and an optional `preset`:

```js
agent_start({
  cwd: "...",
  profile: "lmstudio-devstral",
  preset: "read-only",
  tools: { bash: "deny" },
})
```

This is the escape hatch for scripted or programmatic use where writing an agent def file is overkill.

### 5. MCP tools (ADR 0006) follow the same model

MCP tools are registered alongside built-ins and appear in the `tools:` map using the `<server>__<tool>` naming convention. The preset system does not know about MCP tools (they are not part of any preset), so they default to `ask`. The agent def `tools:` map can promote them to `allow` or `deny` them entirely.

`tool_config:` for MCP tools is not supported in V1 — MCP tool configuration is the server's responsibility, not agnz's.

### 6. Schema serialisation: only registered tools appear

Today `registry.toOpenAISchema()` serialises all registered tools into the LLM's `tools` parameter. After this ADR, tools that the preset excludes are never registered in the first place — they do not appear in the schema at all. This is cleaner than registering everything and relying on `deny` to block execution: a `denied` tool that appears in the schema may still be called by the LLM (and then immediately blocked), adding a turn of latency and confusion.

## What we are NOT building in this ADR

- **Dynamic tool registration during a run.** The tool set is fixed at thread start. Adding a tool mid-run would require re-sending the full schema to the LLM, which some endpoints do not support cleanly.
- **User-defined tools.** Custom tools implemented as scripts or plugins are out of scope. `bash` with `allowedCommands` is the practical equivalent for most cases.
- **Tool versioning.** If a tool's behaviour changes between plugin versions, running threads are not affected — they have the tool version they were spawned with. Same as agent definitions.

## Deferred / Open questions

- **Preset inheritance.** `preset: read-only` plus `tools: { bash: allow }` effectively creates a "read-mostly" preset. If several agents use the same custom composition, a named custom preset in `workspace.json` would be cleaner than repeating the combination in every agent def. Deferred until the pattern is seen in practice.
- **Tool aliasing.** A future use case: expose `bash` to the agent as `run_tests` with a fixed command, so the agent calls `run_tests()` instead of `bash({ command: "npm test" })`. Cleaner schema, less prompt engineering. Requires a thin tool-alias layer. Not in scope here.
