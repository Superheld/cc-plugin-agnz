# ADR 0001: Workspace-first architecture

- **Status:** Proposed
- **Date:** 2026-04-08
- **Branch:** `refactor/workspace-first-architecture`

## Context

Until v0.3.0, agnz is structured around a single unit of work: the **thread**. A thread = one sub-agent run, with its own transcript, meta, and sandbox. The parent (Claude Code) interacts with threads exclusively through the MCP server: 11 tools cover creation, messaging, approval, status queries, memory, and profiles.

This model has two limitations that show up as soon as we try to grow the tool:

1. **Every piece of visibility needs its own MCP tool.** Want to see a thread's status? `agent_status`. All threads? `agent_list_threads`. Profiles? `agent_profiles_list`. Memory? `agent_memory_read`. This gets worse as we add features — todos, logs, team members, workspace state would each demand more tools. The MCP tool surface becomes a second, worse file system.

2. **Threads are isolated.** A thread knows nothing about other threads. There is no shared state between runs, no cross-agent coordination, no persistent "workspace" the parent can look at between actions. The architecture can support a single sub-agent well but has no natural seat for a *team*.

The original framing was "MCP server that exposes a local agent to Claude Code." We want a different framing going forward: **agnz is Claude's own Claude Code — a workspace in which Claude can spawn and orchestrate teams of locally-hosted agents.** That framing demands:

- A shared, inspectable workspace state (todos, members, logs, artifacts)
- Multiple agents that can see and contribute to that state
- Low-friction visibility for the parent — no tool roundtrip to read a file

## Decision

We restructure agnz around a **workspace** as the unit of persistent state, and we draw a new line for what MCP is responsible for:

### 1. The workspace is a directory of files

Per project (`cwd`), agnz keeps a workspace at `<cwd>/.claude/agnz/`:

```
<cwd>/.claude/agnz/
├── workspace.json          ← shared state: todos, members, mode, metadata
├── threads/
│   ├── <thread-id>.meta.json
│   └── <thread-id>.jsonl    ← append-only transcript
├── log.jsonl               ← append-only activity log across all threads
└── scratch/                ← free-form artifact space for agents
```

The workspace is **the source of truth** for the state of agnz in a project. It is plain text/JSON, human-readable, editable by hand, version-controllable (or gitignorable).

User-scoped state that is *not* project-specific — profiles, global memory — moves out of the project workspace and stays in a user-wide location (`~/.claude/agnz/`).

### 2. Parent-side state access is through the filesystem, not MCP

The parent (Claude) reads workspace state directly using its own tools (`Read`, `Grep`, `Edit`, `Write`). No MCP call is required to see a todo list, scan a transcript, or edit workspace metadata. This eliminates entire categories of MCP tools.

### 3. MCP shrinks to process lifecycle only

The MCP server's job becomes: manage things the parent *cannot* manage via files alone — live sub-agent processes. The target tool set is approximately:

- `agent_start(cwd, profile?)` — spawn a sub-agent in a workspace
- `agent_send(thread_id, message)` — send input to a live thread
- `agent_approve(thread_id, tool_call_id, decision, persist?)` — resolve an approval pause
- `agent_answer(thread_id, tool_call_id, answer)` — resolve a question pause
- `agent_wait(thread_id, timeout_ms?)` — block on a detached run
- `agent_stop(thread_id)` — kill a live thread

These five or six tools are the verbs that *require* a live server. Everything else — reading status, listing threads, reading memory, inspecting profiles — becomes file I/O the parent does itself.

Tools that leave: `agent_status`, `agent_list_threads`, `agent_memory_read`, `agent_memory_write`, `agent_profiles_list`. Their read-side moves to direct file access. Their write-side, where it exists, either moves to direct file writes (the parent can just edit `workspace.json`) or, in the case of `/agnz:setup`, stays as a slash command that operates on the user-wide profile file.

### 4. Shared todos as the workspace's first field

`workspace.json` holds a `todos` array shared by the parent and any agent in the workspace. Both sides can read and write it — the parent via `Write`/`Edit`, the sub-agent via a new `todo_edit` tool that operates on the same file. The sub-agent's system prompt is extended to require maintaining the list and to forbid declaring the work complete while any item is still `pending` or `in_progress`.

### 5. Teams follow naturally

Because workspace state is shared and multiple threads can coexist in the same workspace, teams become a matter of spawning more threads with different profiles and letting them read each other's contributions via the log. Messaging between agents is an append-only write to `log.jsonl` — no dedicated messaging channel is needed.

### 6. Planning mode as a workspace flag

A `mode: "planning" | "executing"` field on `workspace.json`. In planning mode, agents are instructed to analyze and propose todos but not to execute mutating tool calls. Flipping the flag (by the parent or by an agent) switches behavior.

## Consequences

### Positive

- **Visibility without tool inflation.** The parent can inspect the entire workspace with one `ls` and a handful of `Read` calls. No new MCP tools needed for new kinds of state.
- **Human-editable state.** The user can open `workspace.json` in an editor, fix a stuck todo, add a member, or version the workspace alongside the project.
- **Clearer boundary.** MCP's responsibility is narrow and well-defined: "things that need a live process." Everything else is "files on disk."
- **Natural path to teams, messaging, planning mode.** Each of these follows from the workspace abstraction without new plumbing.
- **Tool surface shrinks.** From 11 MCP tools to 5–6. Less to document, less to maintain, less to explain to the model.

### Negative / risks

- **Breaking change.** Existing threads under `~/.local/share/agnz/threads/` will not be migrated automatically. Users on v0.3.0 who upgrade lose in-flight threads unless we provide a migration helper. Since the data dir was explicitly designed to be version-stable, we owe users either a migration or at minimum a clear note.
- **Concurrent writes.** If the parent and a sub-agent both edit `workspace.json` simultaneously, one can clobber the other. We need a simple write pattern (read → mutate → write) with a lock file or with atomic rename, and we need to define who owns the write for each field.
- **Scope creep risk.** It is tempting to design the "full IDE for Claude" in one go. We must resist — this ADR defines the *skeleton* (workspace directory, MCP shrink, todos as the first field). Teams, messaging, planning mode, and shared memory come in separate steps, each as its own ADR.
- **Cache-invalidation surprise for slash commands.** Claude Code caches the plugin directory path per-install and sometimes expands `${CLAUDE_PLUGIN_ROOT}` to a stale version. This is a CC-level issue, not ours, but the more we change paths and layouts, the more often we hit it.

### Neutral

- **The `.claude/` convention.** Using `<cwd>/.claude/agnz/` colocates us with whatever other per-project Claude Code state lives under `.claude/`. That is a feature (unified per-project Claude state) and a mild coupling (if CC ever reserves `.claude/` for itself exclusively, we would need to move).
- **Profiles and global memory leave the project workspace.** They move to a user-wide location. This is the right call — they are not project state — but it is worth noting that two locations now matter: the per-project workspace and the user-wide profile/memory store.

## Migration plan (outline)

1. Introduce `<cwd>/.claude/agnz/` as the new workspace root, initially *alongside* the existing data dir. New threads use the new location; old threads under `~/.local/share/agnz/` remain readable.
2. Move profiles and global memory to `~/.claude/agnz/` (or keep at the existing XDG default — to be decided).
3. Remove the four read-only MCP tools (`agent_status`, `agent_list_threads`, `agent_memory_read`, `agent_profiles_list`) after the file-based equivalents are in place.
4. Extend the workspace with `todos` and a `todo_edit` sub-agent tool. Update the sub-agent system prompt.
5. Add `mode: "planning" | "executing"` flag. Wire it into the system prompt.
6. Document the migration in `README.md` with a clear "0.3.x → 0.4.0 breaking changes" section.

## Open questions

These are deliberately left open in this ADR and will be resolved in follow-up ADRs or during implementation:

- **Should `workspace.json` be split into multiple files** (`todos.json`, `members.json`, …) or kept as one? One file is simpler; multiple files reduce write contention.
- **Where exactly do profiles live?** `~/.claude/agnz/profiles.json` or the current `~/.local/share/agnz/profiles.json`? The ADR assumes the former but this needs a final decision.
- **How do we handle concurrent writes to `workspace.json`?** Single process owner? Lock file? Atomic rename? Per-field ownership?
- **What does the transition from v0.3.x look like for users?** Auto-migrate, one-shot migration command, or "read both locations" compatibility period?

## References

- Current code: `lib/data-dir.mjs`, `lib/threads.mjs`, `lib/memory.mjs` (removed in v0.4.0), `mcp/server.mjs`
- Prior framing: `README.md` (pre-refactor version), `CLAUDE.md`
