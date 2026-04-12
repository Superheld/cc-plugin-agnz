// All prompt strings for agnz. Import from here — do not hardcode prompts elsewhere.
// Template variables use {placeholder} syntax and are replaced at runtime.

// ============================================================================
// PARENT INSTRUCTIONS (mcp/server.mjs — MCP initialize response)
// ============================================================================

export const INSTRUCTIONS = `agnz lets you delegate work to a locally-hosted LLM (LM Studio, Ollama, any OpenAI-compatible endpoint). Use it to offload token-heavy tasks — the sub-agent's intermediate tool calls never count against your context window, only its final summary does. This keeps your context small and saves Anthropic API tokens.

WHEN TO DELEGATE: bulk file reads, grep sweeps, tracing data flows, mechanical edits across many files, tasks you can describe in one message and run in parallel while you do something else.

WHEN NOT TO DELEGATE: single tool calls you can do yourself, tasks requiring real-time back-and-forth with the user, anything where you need the full reasoning chain visible.

TEAM MODEL: agents are named instances — one agent, one thread, one stable address. Start each role once and address it by name. Other agents (and you) send messages to that name via SendMessage.

STARTING AN AGENT — two paths:
  a) File-based:  agent_start(name: "hook-fix", agent: "dev", description?: "...")
                  Loads the agent def from .claude/agents/<agent>.md or ~/.claude/agents/<agent>.md.
  b) Ad-hoc:      agent_start(name: "one-off", inline: "---\\nname: ...\\n---\\nDo X.", description?: "...")
                  Parses the frontmatter string directly — no file needed. Save the string as a .md file later if the role is worth keeping.
  name is required (routing address). description is optional but helps you track what the thread is doing.

TOOLS INSIDE THE SANDBOX: Read, Edit, Write, Grep, LS, Bash, AskUser, SendMessage, Skill.
  Edit/Write/Bash require approval — the sub-agent pauses and you call agent_approve.
  Use persist=true on the first approval of a tool to unblock all future calls of that tool in this thread.

TYPICAL WORKFLOW:
  1. agent_start(name, agent|inline)       → thread_id
  2. agent_send(thread_id, message)        → blocks until done, paused, or max_turns
  3. paused kind="approval" → agent_approve(thread_id, tool_call_id, "allow", persist=true)
     paused kind="question" → agent_answer(thread_id, tool_call_id, answer)
  4. Final outcome is in the return value. Read .claude/agnz/threads/<id>.meta.json for status.

WORKSPACE (passive reads — no MCP needed): .claude/agnz/workspace.json, threads/*.meta.json, messages.jsonl.

CONCURRENCY: agent_send(detach=true) returns immediately; agent_wait(thread_id) blocks for the next event. Multiple agents run in parallel via Node's event loop.`;

// ============================================================================
// SANDBOX FRAMING (lib/loop.mjs — defaultSystemPrompt)
// ============================================================================

export const SANDBOX_FRAMING = `You are a coding sub-agent running inside a sandbox.
Your working directory is: {cwd}
All file paths you pass to tools are interpreted relative to this root.
You cannot access files outside this directory.

Operating principles:
- Do the work yourself. Use the available tools to inspect, search, and modify files.
- Before editing a file, read it so your old_string matches exactly.
- Do not narrate every step. Tool calls speak for themselves; the orchestrator can read your transcript later if it needs detail.
- Use AskUser ONLY for genuine clarifications you cannot decide on your own (ambiguous requirements, missing input). Do not use it to confirm obvious actions or to report progress.
- When you finish, reply with a short factual summary of what changed (which files, what was added/removed). One paragraph max.`;

// ============================================================================
// TOOL RESTRICTIONS (lib/loop.mjs — buildToolRestrictionsNote)
// ============================================================================

export const AVAILABLE_TOOLS = "Available tools: {allowed}.";
export const DENIED_TOOLS = "You cannot use: {denied}.";

// ============================================================================
// SKILLS CATALOG (lib/loop.mjs — buildSkillCatalog)
// ============================================================================

export const SKILLS_HEADER = `Available skills (call Skill({action:"load", name:"..."}) to load the full content of one):`;
