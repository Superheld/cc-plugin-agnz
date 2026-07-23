// Agent definitions: agnz loads agent files from Claude Code's standard
// locations, not from its own directory. This means agents defined for CC
// are immediately available to agnz without duplication.
//
// Lookup order:
//   1. <cwd>/.claude/agents/<name>.md   (project scope)
//   2. ~/.claude/agents/<name>.md       (user scope)
//
// Files are plain markdown with a YAML-frontmatter head. We parse a
// deliberately *tiny* subset of YAML — enough for the CC-compatible
// agent-def shape and no more. Bringing in a full YAML parser would
// violate the zero-deps rule of the plugin.
//
// Array fields (tools / disallowedTools / skills) accept two formats:
//   CC native:  disallowedTools: ["Edit", "Write"]     ← preferred
//   YAML block: disallowedTools:                        ← also supported
//                 - Edit
//                 - Write
//
// Text fields (description / prompt / initialPrompt) accept:
//   CC native:  description: First line of text
//
//               <example>...</example>
//
//               (no block-scalar indicator; CC places <example> blocks on
//               the lines immediately below the key — we collect them as
//               part of the value until the next known frontmatter key)
//   YAML block: description: |
//                 Text...
//               (kept for backwards compat; CC also accepts this)
//
// CC native format is preferred for new files.
//
// Field alignment with the CC agent format:
//   name, description, model, color — identical semantics
//   tools           — string array whitelist (CC: only these tools; agnz:
//                     same, but bounded by the profile's defaultPolicy)
//   disallowedTools — string array blacklist (CC + agnz: these are denied)
//   skills          — string array (CC: skills available to agent; agnz:
//                     allowlist for Skill)
//   maxTurns        — positive integer (CC + agnz: hard loop ceiling)
//
// agnz-only fields:
//   temperature     — LLM sampling temperature override

import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

// Single source of truth for the valid agent-name regex. Used both by
// validateAgentDef (which checks the name in frontmatter) and by
// loadAgentDef (which refuses to touch the filesystem with an invalid
// name — a cheap path-traversal guard since the name becomes a
// filename segment).
const NAME_RE = /^[a-z][a-z0-9_-]*$/;

// Keys that open a new frontmatter field at zero indent. Used by the
// CC-style multi-line plain scalar reader to detect where a description
// (which can span multiple lines and include <example> blocks inline)
// ends and the next field begins.
const FRONTMATTER_KEYS = new Set([
  "name", "description", "model", "color", "prompt", "initialPrompt",
  "temperature", "maxTurns", "tools", "disallowedTools", "skills",
]);

// Count leading-whitespace columns.
const indentOf = (s) => s.length - s.replace(/^\s+/, "").length;

/**
 * Parse a sequence block (tools / disallowedTools / skills).
 * Reads `- item` lines until a zero-indent non-blank line or `---`.
 * Returns [items, nextIndex].
 */
function parseSequence(lines, i, filename) {
  const items = [];
  while (i < lines.length && lines[i].trim() !== "---") {
    const childRaw = lines[i];
    const childTrim = childRaw.trim();
    if (childTrim === "") { i++; continue; }
    if (indentOf(childRaw) === 0) break;
    const item = childTrim.match(/^-\s+(\S.*\S|\S)\s*$/);
    if (!item) {
      throw new Error(
        `agent-def parse error in ${filename}: unsupported sequence entry at line ${i + 1}`,
      );
    }
    items.push(item[1]);
    i++;
  }
  return [items, i];
}

/**
 * Parse the agent-def source into a plain object. Pure function.
 *
 * Supported frontmatter constructs:
 *   key: value          — one-line scalar
 *   key: >              — folded multi-line (trimmed, joined with spaces)
 *   key: |              — literal multi-line (newlines preserved, for <example> blocks)
 *   tools:              — string array (sequence of `- toolName`)
 *   disallowedTools:    — string array (sequence of `- toolName`)
 *   skills:             — string array (sequence of `- skillName`)
 */
export function parseAgentDefSource(source, filename) {
  const lines = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");

  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;

  if (i >= lines.length || lines[i].trim() !== "---") {
    throw new Error(
      `agent-def parse error in ${filename}: file must start with a '---' frontmatter fence`,
    );
  }
  i++;

  const out = { body: "" };

  while (i < lines.length && lines[i].trim() !== "---") {
    const raw = lines[i];
    const trimmed = raw.trim();

    if (trimmed === "") { i++; continue; }

    if (indentOf(raw) !== 0) {
      throw new Error(
        `agent-def parse error in ${filename}: unexpected indentation at line ${i + 1}`,
      );
    }

    const kv = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) {
      throw new Error(
        `agent-def parse error in ${filename}: unsupported frontmatter construct at line ${i + 1}`,
      );
    }
    const key = kv[1];
    const rest = kv[2];

    // --- sequence fields: CC JSON array or YAML block sequence ---
    if (key === "tools" || key === "disallowedTools" || key === "skills") {
      if (rest.trim() === "") {
        // YAML block sequence:  tools:\n  - Read\n  - Grep
        i++;
        const [items, next] = parseSequence(lines, i, filename);
        out[key] = items;
        i = next;
      } else if (rest.trim().startsWith("[")) {
        // CC JSON array:  tools: ["Read", "Grep"]
        let arr;
        try { arr = JSON.parse(rest.trim()); } catch {
          throw new Error(
            `agent-def parse error in ${filename}: '${key}:' contains malformed JSON array at line ${i + 1}`,
          );
        }
        if (!Array.isArray(arr)) {
          throw new Error(
            `agent-def parse error in ${filename}: '${key}:' value must be an array at line ${i + 1}`,
          );
        }
        out[key] = arr;
        i++;
      } else {
        throw new Error(
          `agent-def parse error in ${filename}: '${key}:' must be a block sequence or JSON array at line ${i + 1}`,
        );
      }
      continue;
    }

    // --- folded block scalar (key: >, incl. chomping variants >- / >+) ---
    if (/^>[+-]?$/.test(rest.trim())) {
      i++;
      const parts = [];
      while (i < lines.length && lines[i].trim() !== "---") {
        const contRaw = lines[i];
        const contTrim = contRaw.trim();
        if (contTrim === "") { i++; continue; }
        if (indentOf(contRaw) === 0) break;
        parts.push(contTrim);
        i++;
      }
      setScalar(out, key, parts.join(" "), filename, i);
      continue;
    }

    // --- literal block scalar (key: |, incl. chomping variants |- / |+) ---
    // Preserves newlines — required for CC-style <example> blocks.
    if (/^\|[+-]?$/.test(rest.trim())) {
      i++;
      let refIndent = -1;
      const parts = [];
      while (i < lines.length && lines[i].trim() !== "---") {
        const contRaw = lines[i];
        if (contRaw.trim() !== "" && indentOf(contRaw) === 0) break;
        if (refIndent === -1 && contRaw.trim() !== "") {
          refIndent = indentOf(contRaw);
        }
        const stripped = refIndent > 0 ? contRaw.replace(new RegExp(`^ {0,${refIndent}}`), "") : contRaw;
        parts.push(stripped);
        i++;
      }
      while (parts.length > 0 && parts[parts.length - 1].trim() === "") parts.pop();
      setScalar(out, key, parts.join("\n"), filename, i);
      continue;
    }

    // --- plain scalar ---
    // For text fields CC places <example> blocks on the lines immediately
    // below the key — no block-scalar indicator. Collect continuation
    // lines as part of the value, stopping at the next known frontmatter
    // key or the closing fence.  Inside <example>...</example> blocks we
    // do not break on keys like `user:` or `model:` that look like
    // frontmatter but are part of the example body.
    if (key === "description" || key === "prompt" || key === "initialPrompt") {
      i++;
      const parts = [rest];
      let depth = 0; // <example> nesting depth
      while (i < lines.length && lines[i].trim() !== "---") {
        const contRaw = lines[i];
        const contTrim = contRaw.trim();
        if (contTrim === "<example>" || contTrim.startsWith("<example ")) depth++;
        if (contTrim === "</example>") depth = Math.max(0, depth - 1);
        if (depth === 0 && contTrim !== "" && indentOf(contRaw) === 0) {
          const m = contTrim.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:/);
          if (m && FRONTMATTER_KEYS.has(m[1])) break;
        }
        parts.push(contTrim === "" ? "" : contTrim);
        i++;
      }
      while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
      setScalar(out, key, parts.join("\n"), filename, i);
    } else {
      setScalar(out, key, rest, filename, i + 1);
      i++;
    }
  }

  if (i >= lines.length) {
    throw new Error(
      `agent-def parse error in ${filename}: missing closing '---' frontmatter fence`,
    );
  }
  i++;

  out.body = lines.slice(i).join("\n").trim();
  return out;
}

function setScalar(out, key, value, filename, line) {
  const v = value.trim();
  switch (key) {
    case "name":
    case "description":
    case "color":       // CC-compatible, stored for future UI use
    case "prompt":      // CC-compatible: inline system prompt (alternative to body)
    case "initialPrompt": // CC-compatible: initial prompt
      out[key] = v;
      return;
    case "model":
      // In CC: inherit/sonnet/opus/haiku. In agnz: our profile name.
      // Stored as-is; server.mjs resolves it against the profile store.
      out[key] = v;
      return;
    case "temperature": {
      const num = Number(v);
      if (!Number.isFinite(num)) {
        throw new Error(
          `agent-def parse error in ${filename}: temperature must be a number at line ${line}`,
        );
      }
      out.temperature = num;
      return;
    }
    case "maxTurns": {
      const num = Number(v);
      if (!Number.isInteger(num) || num <= 0) {
        throw new Error(
          `agent-def parse error in ${filename}: maxTurns must be a positive integer at line ${line}`,
        );
      }
      out.maxTurns = num;
      return;
    }
    default:
      // Unknown keys silently ignored for forward compat.
      return;
  }
}

/**
 * Validate a parsed def. Throws on required-field violations.
 */
export function validateAgentDef(def, filename) {
  if (!def || typeof def !== "object") {
    throw new Error(`agent-def validation error in ${filename}: def is not an object`);
  }
  if (typeof def.name !== "string" || !NAME_RE.test(def.name)) {
    throw new Error(
      `agent-def validation error in ${filename}: name must match ${NAME_RE}`,
    );
  }
  if (typeof def.description !== "string" || def.description === "") {
    throw new Error(`agent-def validation error in ${filename}: description is required`);
  }
  if (def.tools !== undefined && !Array.isArray(def.tools)) {
    throw new Error(`agent-def validation error in ${filename}: tools must be a sequence`);
  }
  if (def.disallowedTools !== undefined && !Array.isArray(def.disallowedTools)) {
    throw new Error(`agent-def validation error in ${filename}: disallowedTools must be a sequence`);
  }
  if (def.skills !== undefined && !Array.isArray(def.skills)) {
    throw new Error(`agent-def validation error in ${filename}: skills must be a sequence`);
  }
}

/**
 * Build the effective per-tool policy for a thread from the agent def.
 *
 * Logic:
 *   1. If agent has tools (whitelist): only listed tools are allowed.
 *   2. If agent has disallowedTools: those are denied.
 *   3. Everything else: "ask" (prompt for approval).
 *
 * Session approvals (from agent_approve) override this for that session
 * and are stored in the thread meta.
 *
 * Inputs are not mutated.
 */
export function buildToolPolicy(agentDef, availableTools = []) {
  const { tools, disallowedTools, skills } = agentDef || {};
  const out = {};

  // All tools default to "ask".
  for (const tool of availableTools) {
    out[tool] = "ask";
  }

  // Agent def whitelist: explicit allow.
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      out[tool] = "allow";
    }
  }

  // Agent def deny list: explicit deny overrides everything.
  if (Array.isArray(disallowedTools)) {
    for (const tool of disallowedTools) {
      out[tool] = "deny";
    }
  }

  // Skill is always auto-allowed (it's read-only and sandboxed to known paths)
  // unless the agent explicitly denies it.
  if (out["Skill"] !== "deny") {
    out["Skill"] = "allow";
  }

  // SendMessage is the architecture's publishing channel (ADR 0002): it only
  // appends to the workspace's own messages.jsonl — no filesystem or exec
  // reach — and both the mailbox design and the team roadmap (ADR 0018)
  // presume agents can publish freely. Auto-allow like Skill unless the def
  // explicitly denies it; before this, no bundled agent whitelisted it, so
  // every agent-to-agent or status message paused for approval.
  if (out["SendMessage"] !== "deny") {
    out["SendMessage"] = "allow";
  }

  // Footgun guard: a tools/disallowedTools entry that isn't a real tool (a
  // typo) silently does nothing — a misspelled disallowedTools entry leaves
  // the intended tool at "ask" rather than denied. Warn so it's visible.
  if (availableTools.length > 0) {
    const known = new Set(availableTools);
    for (const [field, list] of [["tools", tools], ["disallowedTools", disallowedTools]]) {
      if (!Array.isArray(list)) continue;
      for (const t of list) {
        if (!known.has(t)) {
          console.warn(`agnz: agent def ${field} lists unknown tool '${t}' (typo? has no effect)`);
        }
      }
    }
  }

  return out;
}

/**
 * Load and validate a single agent definition by name.
 * Lookup order:
 *   1. <cwd>/.claude/agents/<name>.md  — project-specific (highest priority)
 *   2. ~/.claude/agents/<name>.md      — user-wide
 *   3. <pluginRoot>/agents/<name>.md   — plugin-bundled defaults (lowest priority)
 *
 * pluginRoot is optional; pass it from the MCP server so bundled agents are
 * always available regardless of the project the user is working in.
 */
export async function loadAgentDef(cwd, name, pluginRoot) {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new Error(`agent definition not found: ${name}`);
  }

  const paths = [
    resolve(cwd, ".claude", "agents", `${name}.md`),
    resolve(homedir(), ".claude", "agents", `${name}.md`),
    ...(pluginRoot ? [resolve(pluginRoot, "agents", `${name}.md`)] : []),
  ];

  for (const filePath of paths) {
    try {
      const source = await readFile(filePath, "utf8");
      const def = parseAgentDefSource(source, `${name}.md`);
      validateAgentDef(def, filePath);
      return def;
    } catch (err) {
      if (err?.code === "ENOENT") continue;
      throw err;
    }
  }

  throw new Error(`agent definition not found: ${name}`);
}

/**
 * List every *.md under the CC agent directories that parses and
 * validates successfully. Returns [] if no directory exists.
 * Priority (later entries shadow earlier ones): plugin → user → project.
 */
export async function listAgentDefs(cwd, pluginRoot) {
  const dirs = [
    ...(pluginRoot ? [resolve(pluginRoot, "agents")] : []),
    resolve(homedir(), ".claude", "agents"),
    resolve(cwd, ".claude", "agents"),
  ];

  const seen = new Map();

  for (const agentsDir of dirs) {
    let entries;
    try {
      entries = await readdir(agentsDir);
    } catch (err) {
      if (err?.code === "ENOENT") continue;
      throw err;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const stem = entry.slice(0, -3);
      if (seen.has(stem)) continue;
      try {
        const def = await loadAgentDef(cwd, stem, pluginRoot);
        const projectDir = resolve(cwd, ".claude", "agents");
        const userDir = resolve(homedir(), ".claude", "agents");
        const source =
          agentsDir === projectDir ? "project"
          : agentsDir === userDir ? "user"
          : "plugin";
        seen.set(stem, { name: def.name, description: def.description, source });
      } catch {
        // Skip malformed files silently.
      }
    }
  }

  return [...seen.values()];
}
