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

    // --- sequence fields ---
    if (key === "tools" || key === "disallowedTools" || key === "skills") {
      if (rest.trim() !== "") {
        throw new Error(
          `agent-def parse error in ${filename}: '${key}:' must start a sequence at line ${i + 1}`,
        );
      }
      i++;
      const [items, next] = parseSequence(lines, i, filename);
      out[key] = items;
      i = next;
      continue;
    }

    // --- folded block scalar (key: >) ---
    if (rest === ">") {
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

    // --- literal block scalar (key: |) ---
    // Preserves newlines — required for CC-style <example> blocks.
    if (rest === "|") {
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

    // --- plain one-line scalar ---
    setScalar(out, key, rest, filename, i + 1);
    i++;
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
 * Build the effective per-tool policy for a thread from the profile's
 * defaultPolicy and the agent def's tool restrictions.
 *
 * Logic (mirrors CC semantics):
 *   1. Start from the profile's defaultPolicy.
 *   2. If `tools` (whitelist) is set: only listed tools keep their profile
 *      decision; all others are denied. Profile is the upper bound —
 *      listing a tool can never promote it beyond what the profile allows.
 *   3. Apply `disallowedTools` (blacklist) on top: listed tools are denied
 *      regardless of the whitelist or profile.
 *   4. If neither is set: profile defaults pass through unchanged.
 *
 * Inputs are not mutated.
 */
export function mergeEffectivePolicy(profilePolicy, agentDef) {
  const base = { ...(profilePolicy || {}) };
  const { tools, disallowedTools } = agentDef || {};

  let out;
  if (Array.isArray(tools)) {
    // Whitelist mode: start with everything denied, then restore profile
    // decisions for the explicitly listed tools.
    out = {};
    for (const tool of Object.keys(base)) {
      out[tool] = "deny";
    }
    for (const tool of tools) {
      // Profile is the upper bound: if it says ask/deny, we cannot promote.
      out[tool] = base[tool] ?? "allow";
    }
  } else {
    out = base;
  }

  // Blacklist: deny on top of everything else.
  if (Array.isArray(disallowedTools)) {
    for (const tool of disallowedTools) {
      out[tool] = "deny";
    }
  }

  return out;
}

/**
 * Load and validate a single agent definition by name.
 * Lookup order: project agents first, then user agents.
 */
export async function loadAgentDef(cwd, name) {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new Error(`agent definition not found: ${name}`);
  }

  const projectPath = resolve(cwd, ".claude", "agents", `${name}.md`);
  const userPath = resolve(homedir(), ".claude", "agents", `${name}.md`);

  const paths = [projectPath, userPath];
  let lastErr = null;

  for (const filePath of paths) {
    try {
      const source = await readFile(filePath, "utf8");
      const def = parseAgentDefSource(source, `${name}.md`);
      validateAgentDef(def, filePath);
      return def;
    } catch (err) {
      if (err?.code === "ENOENT") {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }

  throw new Error(`agent definition not found: ${name}`);
}

/**
 * List every *.md under the CC agent directories that parses and
 * validates successfully. Returns [] if neither directory exists.
 * Project agents shadow user agents with the same name.
 */
export async function listAgentDefs(cwd) {
  const projectDir = resolve(cwd, ".claude", "agents");
  const userDir = resolve(homedir(), ".claude", "agents");

  const seen = new Map();

  for (const agentsDir of [userDir, projectDir]) {
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
        const def = await loadAgentDef(cwd, stem);
        seen.set(stem, { name: def.name, description: def.description, source: agentsDir === projectDir ? "project" : "user" });
      } catch {
        // Skip malformed files silently.
      }
    }
  }

  return [...seen.values()];
}
