// Agent definitions: role files that layer a system prompt and a
// tool-policy override on top of a profile. See ADR 0003.
//
// Files live per-project at <cwd>/.claude/agnz/agents/<name>.md and are
// plain markdown with a YAML-frontmatter head. We parse a deliberately
// *tiny* subset of YAML here — enough for the ADR-shaped files and no
// more. Bringing in a full YAML parser would violate the zero-deps rule
// of the plugin. If a file uses a construct we do not support, we throw
// a clear error naming the file and line, so the user can fix it.
//
// The parser is one function, the loader/lister are two more. Keep it
// small and auditable; if it ever needs to grow past "very simple", we
// should instead pick a tiny hand-picked YAML lib and document why.

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

// Policy decisions we accept in the `tools:` map. Kept as a local
// constant rather than imported from sandbox.mjs to keep this module
// decoupled from the Decision enum's exact shape — the sandbox accepts
// the string form too.
const DECISIONS = new Set(["allow", "ask", "deny"]);

// Ordering used by mergeEffectivePolicy. Higher = stricter. The profile
// decision and the agent decision are compared and the stricter wins.
const STRICTNESS = { allow: 1, ask: 2, deny: 3 };

// Single source of truth for the valid agent-name regex. Used both by
// validateAgentDef (which checks the name in frontmatter) and by
// loadAgentDef (which refuses to touch the filesystem with an invalid
// name — a cheap path-traversal guard since the name becomes a
// filename segment).
const NAME_RE = /^[a-z][a-z0-9_-]*$/;

// Count leading-whitespace columns. Tabs are counted as one column; we
// do not resolve them to a tab stop, so mixing tabs and spaces under
// `tools:` can silently miscount. The agent-def format is expected to
// use plain spaces and all example roles do.
const indentOf = (s) => s.length - s.replace(/^\s+/, "").length;

/**
 * Parse the agent-def source into a plain object. Pure function: the
 * only inputs are `source` (the file text) and `filename` (used only
 * for error messages). Missing optional fields come back as
 * `undefined`. Required-field enforcement is delegated to
 * validateAgentDef — here we only complain about things that are
 * syntactically unsupported.
 *
 * Supported frontmatter subset:
 *   key: value               (one-line scalar)
 *   key: >                   (folded multi-line: following lines must
 *     continuation            be indented MORE than `key`; they are
 *     continuation            trimmed and joined with spaces)
 *   tools:                   (nested one-level map; each child must be
 *     toolName: allow         indented more than `tools:` and have a
 *     toolName: deny          value from allow|ask|deny)
 */
export function parseAgentDefSource(source, filename) {
  // Normalise line endings and strip a leading BOM so files saved by a
  // "helpful" editor (Windows CRLF, UTF-8 BOM) still parse identically
  // to POSIX-LF/no-BOM files.
  const lines = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");

  // Skip blank lines before the opening fence.
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;

  if (i >= lines.length || lines[i].trim() !== "---") {
    throw new Error(
      `agent-def parse error in ${filename}: file must start with a '---' frontmatter fence`,
    );
  }
  i++; // consume opening fence

  const out = { body: "" };

  // Walk frontmatter lines until the closing fence.
  while (i < lines.length && lines[i].trim() !== "---") {
    const raw = lines[i];
    const trimmed = raw.trim();

    // Blank frontmatter lines are fine; skip them.
    if (trimmed === "") {
      i++;
      continue;
    }

    // Must be a top-level (unindented) key line at this point. `tools:`
    // is the only nested structure we support and its children are
    // consumed inside its own branch below, never visible at this level.
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

    // --- skills: sequence (ADR 0005) ---
    if (key === "skills") {
      if (rest.trim() !== "") {
        throw new Error(
          `agent-def parse error in ${filename}: 'skills:' must start a sequence at line ${i + 1}`,
        );
      }
      i++;
      const skills = [];
      while (i < lines.length && lines[i].trim() !== "---") {
        const childRaw = lines[i];
        const childTrim = childRaw.trim();
        if (childTrim === "") { i++; continue; }
        if (indentOf(childRaw) === 0) break; // sequence is over
        const item = childTrim.match(/^-\s+(\S+)\s*$/);
        if (!item) {
          throw new Error(
            `agent-def parse error in ${filename}: unsupported skills entry at line ${i + 1}`,
          );
        }
        skills.push(item[1]);
        i++;
      }
      out.skills = skills;
      continue;
    }

    // --- tools: nested map ---
    if (key === "tools") {
      if (rest.trim() !== "") {
        throw new Error(
          `agent-def parse error in ${filename}: 'tools:' must start a nested map at line ${i + 1}`,
        );
      }
      i++;
      const tools = {};
      while (i < lines.length && lines[i].trim() !== "---") {
        const childRaw = lines[i];
        const childTrim = childRaw.trim();
        if (childTrim === "") { i++; continue; }
        if (indentOf(childRaw) === 0) break; // nested map is over
        const childKv = childTrim.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(\S+)\s*$/);
        if (!childKv) {
          throw new Error(
            `agent-def parse error in ${filename}: unsupported tools entry at line ${i + 1}`,
          );
        }
        const [, toolName, decision] = childKv;
        if (!DECISIONS.has(decision)) {
          throw new Error(
            `agent-def parse error in ${filename}: tools.${toolName} must be 'allow', 'ask', or 'deny' at line ${i + 1}`,
          );
        }
        tools[toolName] = decision;
        i++;
      }
      out.tools = tools;
      continue;
    }

    // --- folded block scalar (key: >) ---
    // Lines are trimmed and joined with spaces — newlines lost. Good for
    // prose descriptions that should flow as a single paragraph.
    if (rest === ">") {
      i++;
      const parts = [];
      while (i < lines.length && lines[i].trim() !== "---") {
        const contRaw = lines[i];
        const contTrim = contRaw.trim();
        if (contTrim === "") { i++; continue; }
        if (indentOf(contRaw) === 0) break; // back at top-level, block over
        parts.push(contTrim);
        i++;
      }
      setScalar(out, key, parts.join(" "), filename, i);
      continue;
    }

    // --- literal block scalar (key: |) ---
    // Preserves newlines. Required for CC-compatible descriptions that
    // embed <example> blocks. Indentation of the first content line sets
    // the reference indent; that many leading spaces are stripped from
    // every subsequent line (standard YAML literal block behaviour).
    if (rest === "|") {
      i++;
      let refIndent = -1;
      const parts = [];
      while (i < lines.length && lines[i].trim() !== "---") {
        const contRaw = lines[i];
        // A zero-indent non-empty line ends the block.
        if (contRaw.trim() !== "" && indentOf(contRaw) === 0) break;
        if (refIndent === -1 && contRaw.trim() !== "") {
          refIndent = indentOf(contRaw);
        }
        const stripped = refIndent > 0 ? contRaw.replace(new RegExp(`^ {0,${refIndent}}`), "") : contRaw;
        parts.push(stripped);
        i++;
      }
      // Trim trailing blank lines (YAML chomping default: clip).
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
  i++; // consume closing fence

  out.body = lines.slice(i).join("\n").trim();
  return out;
}

// Assign a scalar into the result object with the right type coercion.
// Unknown keys are silently ignored — we do not want the parser to
// break if we add a new optional field later. Presence of required
// fields is validateAgentDef's job.
function setScalar(out, key, value, filename, line) {
  const v = value.trim();
  switch (key) {
    case "name":
    case "profile":
    case "description":
    case "color":   // CC-compatible field — stored, not yet used by the loop
    case "model":   // CC-compatible field — profile takes precedence; stored for future use
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
    case "reviewRequired": {
      if (v === "true") out.reviewRequired = true;
      else if (v === "false") out.reviewRequired = false;
      else {
        throw new Error(
          `agent-def parse error in ${filename}: reviewRequired must be 'true' or 'false' at line ${line}`,
        );
      }
      return;
    }
    default:
      // Unknown keys are silently ignored for forward compat.
      return;
  }
}

/**
 * Validate a parsed def. Throws with a filename-aware error on any
 * violation of the required-field contract. Type checks for optional
 * fields (temperature, maxTurns, reviewRequired) are enforced by
 * setScalar at parse time, so this function trusts the parser for
 * those and only enforces what the parser cannot know: that required
 * fields are present and that the `name` matches NAME_RE.
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
  // profile is optional — if absent, agent_start falls back to the active
  // profile. This matches the CC agent format which has no profile field.
  if (def.profile !== undefined && (typeof def.profile !== "string" || def.profile === "")) {
    throw new Error(`agent-def validation error in ${filename}: profile must be a non-empty string`);
  }
  if (typeof def.description !== "string" || def.description === "") {
    throw new Error(`agent-def validation error in ${filename}: description is required`);
  }
  if (def.tools !== undefined) {
    if (typeof def.tools !== "object" || def.tools === null || Array.isArray(def.tools)) {
      throw new Error(`agent-def validation error in ${filename}: tools must be a plain object`);
    }
  }
  if (def.skills !== undefined) {
    if (!Array.isArray(def.skills)) {
      throw new Error(`agent-def validation error in ${filename}: skills must be a sequence`);
    }
  }
}

/**
 * Merge a profile's defaultPolicy with an agent def's `tools` override.
 * The profile is the upper bound: the agent may only restrict, never
 * expand. `strictest` wins, with order deny > ask > allow. Tools that
 * appear only in the agent def are included with the agent's decision
 * (treated as if the profile had said "allow" for them). Tools that
 * appear only in the profile pass through unchanged. Inputs are not
 * mutated.
 */
export function mergeEffectivePolicy(profilePolicy, agentTools) {
  const out = { ...(profilePolicy || {}) };
  for (const [tool, agentDecision] of Object.entries(agentTools || {})) {
    const profileDecision = out[tool];
    if (profileDecision === undefined) {
      out[tool] = agentDecision;
      continue;
    }
    out[tool] =
      STRICTNESS[agentDecision] >= STRICTNESS[profileDecision]
        ? agentDecision
        : profileDecision;
  }
  return out;
}

/**
 * Load and validate a single agent definition by name. Resolves to
 * <cwd>/.claude/agnz/agents/<name>.md. Throws a clear "not found"
 * error either when the name fails NAME_RE (we refuse to touch the
 * filesystem with an invalid name) or when the file does not exist.
 * Other errors (parse, validate) bubble up with their own messages.
 */
export async function loadAgentDef(cwd, name) {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new Error(`agent definition not found: ${name}`);
  }
  const filePath = resolve(cwd, ".claude", "agnz", "agents", `${name}.md`);
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new Error(`agent definition not found: ${name}`);
    }
    throw err;
  }
  const def = parseAgentDefSource(source, `${name}.md`);
  validateAgentDef(def, `${name}.md`);
  return def;
}

/**
 * List every *.md file under <cwd>/.claude/agnz/agents/ that parses
 * AND validates successfully, and return `{name, description}` for
 * each. Files that fail parse or validate are skipped silently — they
 * are a user authoring problem, not a plugin error, and we do not
 * want one broken file to hide the healthy ones.
 *
 * Returns [] if the directory does not exist.
 */
export async function listAgentDefs(cwd) {
  const agentsDir = resolve(cwd, ".claude", "agnz", "agents");
  let entries;
  try {
    entries = await readdir(agentsDir);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const stem = entry.slice(0, -3);
    try {
      const def = await loadAgentDef(cwd, stem);
      out.push({ name: def.name, description: def.description });
    } catch {
      // Skip malformed files silently.
    }
  }
  return out;
}
