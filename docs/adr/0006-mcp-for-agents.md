# ADR 0006: MCP servers for agents — external tool surface via Model Context Protocol

- **Status:** Proposed (roadmap)
- **Date:** 2026-04-09
- **Depends on:** [ADR 0003](./0003-agent-definitions.md), [ADR 0005](./0005-skills-for-agents.md)

## Context

Sub-agents today are limited to the built-in tool set: `list_dir`, `read_file`, `grep`, `edit_file`, `write_file`, `bash`, `ask_user`, `send_message`, `use_skill`. This covers the common case of file-level coding work, but excludes anything the project connects to via MCP: databases, APIs, browser automation, search engines, internal tools.

Claude Code's parent session has access to every MCP server defined in the project's `.mcp.json`. Sub-agents currently have none. The gap is widest when a task requires both file work *and* an external service — e.g. an agent that reads a Jira ticket (via the Atlassian MCP) and writes the corresponding code. Today that requires the parent to relay information manually.

## Decision

### 1. MCP servers declared in the agent definition

An agent definition may declare which MCP servers it is allowed to connect to:

```markdown
---
name: jira-coder
profile: lmstudio-devstral
description: Reads Jira tickets and implements the described changes.
mcp:
  - atlassian
  - context7
---
```

The values under `mcp:` are **server names** that must exist in the project's `.mcp.json`. At thread-start time, agnz connects to those servers, discovers their tools, and registers them alongside the built-ins.

### 2. Tool policy for MCP tools

MCP tools are external and potentially side-effecting. Default policy: `ask` — the parent must approve each invocation for the first call, with the option to `persist=true` for the rest of the thread. This mirrors how `edit_file` and `bash` work today.

An agent def may override this per server or per tool:

```yaml
tools:
  atlassian__get_issue: allow       # read-only Jira fetch, safe to auto-allow
  atlassian__create_issue: deny     # this agent must never create issues
```

Tool names for MCP tools use the convention `<server>__<tool>` to avoid collisions with built-in names.

### 3. Where MCP config lives

The project's `.mcp.json` is the single source of truth for server definitions (URL, command, env). The agent def only references server names — it does not duplicate connection details. This keeps secrets and endpoint config out of agent definitions.

If a server named in `mcp:` is not present in `.mcp.json`, `agent_start` fails with a clear error rather than silently connecting to nothing.

### 4. Connection lifecycle

MCP connections are established at thread-start and closed at thread-end. A connection failure for a non-critical server logs a warning and continues without that server's tools — the agent proceeds with reduced capability rather than refusing to start. A connection failure for a server the agent actively needs is surfaced via a tool error on first use.

### 5. agnz as a nested MCP client

agnz is itself an MCP server (it exposes `agent_*` tools to the parent). Connecting to external MCP servers makes it simultaneously a **client**. This is architecturally clean — the parent's Claude Code session is the root MCP client, and agnz's sub-agents are downstream clients. There is no circular dependency as long as sub-agents do not attempt to connect back to the parent's agnz instance.

## What we are NOT building in this ADR

- **Dynamic MCP server discovery.** Servers must be named explicitly in the agent def. Auto-exposing every server in `.mcp.json` to every agent would violate the principle of least privilege.
- **Streaming MCP tools.** If a tool streams partial results, we await the full result before returning it to the LLM, same as built-in tools.
- **MCP servers spawned by agnz itself.** Sub-agents cannot start new MCP servers. They consume existing ones.

## Deferred / Open questions

- **Credential isolation.** If two concurrent sub-agents both use the same MCP server with per-user credentials, do they share a session or get separate ones? Depends on the server. Needs case-by-case testing.
- **Tool schema conflicts.** Two MCP servers may expose a tool with the same name. The `<server>__<tool>` naming convention prevents collisions at the registry level but we need to validate this in practice.
- **agnz-to-agnz MCP.** A sub-agent that needs to spawn another sub-agent could theoretically call agnz's own MCP tools. This is an interesting multi-level orchestration pattern but potentially very complex. Explicitly out of scope for this ADR.
