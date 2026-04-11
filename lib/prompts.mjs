// All prompt strings for agnz. Import from here — do not hardcode prompts elsewhere.
// Template variables use {placeholder} syntax and are replaced at runtime.

// ============================================================================
// PARENT INSTRUCTIONS (mcp/server.mjs — MCP initialize response)
// ============================================================================

export const INSTRUCTIONS = `agnz exposes a sandboxed, locally-hosted LLM as a sub-agent you (the parent) can delegate work to. The sub-agent runs its own tool loop against a model you control (LM Studio, Ollama, any OpenAI-compatible endpoint) and only reports the final outcome back to you.

WHEN TO DELEGATE: read-heavy work (bulk file reads, grep sweeps, "find everywhere X is used"), mechanical edits across many files, tasks you want to run in parallel while you do something else, anything where the intermediate tool calls would bloat your own context. The sub-agent's intermediate steps don't count against your context window — only its final summary does.

WHEN NOT TO DELEGATE: quick one-liners you can do in one tool call, tasks that need real-time back-and-forth with the user, situations where you need the full reasoning chain in your own context.

AGENTS: All Claude Code agents (from ~/.claude/agents/ or <cwd>/.claude/agents/) can be started as agnz sub-agents. Just pass agent: "<name>" to agent_start and the agent's config, tools, and system prompt are loaded automatically. Without an agent, the sub-agent runs with a generic prompt.

WHAT THE SUB-AGENT CAN DO: inside its sandbox it has Read, Edit, Write, Grep, LS, Bash, AskUser, SendMessage, Skill. Locked to a single cwd. Edit/Write/Bash are gated by default — the sub-agent pauses and you approve via agent_approve. Skill is a framework tool: when skills: is set in the agent def, the agent sees a catalog in its system prompt and calls Skill({action:'load', name:'...'}) to pull in full content on demand.

WORKSPACE LAYOUT: per-project state at <cwd>/.claude/agnz/. Read workspace.json, threads/*.meta.json, and the messages.jsonl log with your own Read/Glob/Grep — no MCP call needed. MCP tools are for live process operations only (start, send, approve, answer, wait, stop).

TYPICAL WORKFLOW:
  1. agent_start(cwd, agent?: "<name>") — create a thread. Returns thread_id.
  2. agent_send(thread_id, message) — give it a task; blocks until done, paused, or max_turns.
  3. If paused: check returned kind ("approval" or "question"), call agent_approve or agent_answer.
  4. Read the outcome from the return value — do NOT re-read the transcript unless you need detail.

CONCURRENCY: detach=true on agent_send returns immediately; agent_wait(thread_id) blocks for the next event. Multiple sub-agents run in parallel freely via Node's event loop.`;

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
