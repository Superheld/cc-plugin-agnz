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
  if (typeof source !== "string") {
    throw new Error(`agent-def parse error in ${filename}: source must be a string`);
  }
  const lines = source.split("\n");

  // Skip a leading BOM / blank lines before the opening fence so that
  // files saved by a "helpful" editor still parse.
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;

  if (i >= lines.length || lines[i].trim() !== "---") {
    throw new Error(
      `agent-def parse error in ${filename}: file must start with a '---' frontmatter fence`,
    );
  }
  i++; // consume opening fence

  const out = {
    name: undefined,
    profile: undefined,
    description: undefined,
    tools: undefined,
    temperature: undefined,
    maxTurns: undefined,
    reviewRequired: undefined,
    body: "",
  };

  // Walk frontmatter lines until the closing fence.
  while (i < lines.length && lines[i].trim() !== "---") {
    const raw = lines[i];
    const trimmed = raw.trim();

    // Blank frontmatter lines are fine; skip them.
    if (trimmed === "") {
      i++;
      continue;
    }

    // Must be a top-level (unindented) key line at this point. Any
    // indentation here is unexpected — `tools:` is the only nested
    // structure we support and its children are consumed inside its
    // own branch below, never visible at this level.
    const indent = raw.length - raw.replace(/^\s+/, "").length;
    if (indent !== 0) {
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
        // If this line is not indented, the nested map is over.
        const childIndent = childRaw.length - childRaw.replace(/^\s+/, "").length;
        if (childIndent === 0) break;
        const childKv = childTrim.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(\S+)\s*$/);
        if (!childKv) {
          throw new Error(
            `agent-def parse error in ${filename}: unsupported tools entry at line ${i + 1}`,
          );
        }
        tools[childKv[1]] = childKv[2];
        i++;
      }
      out.tools = tools;
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
        const contIndent = contRaw.length - contRaw.replace(/^\s+/, "").length;
        if (contIndent === 0) break; // back at top-level, block over
        parts.push(contTrim);
        i++;
      }
      setScalar(out, key, parts.join(" "), filename, i);
      continue;
    }

    // --- plain one-line scalar ---
    setScalar(out, key, rest, filename, i);
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
// break if we add a new optional field later. Validation of presence
// and value range is validateAgentDef's job.
function setScalar(out, key, value, filename, lineIdx) {
  const v = value.trim();
  switch (key) {
    case "name":
    case "profile":
    case "description":
      out[key] = v;
      return;
    case "temperature": {
      const num = Number(v);
      if (!Number.isFinite(num)) {
        throw new Error(
          `agent-def parse error in ${filename}: temperature must be a number at line ${lineIdx}`,
        );
      }
      out.temperature = num;
      return;
    }
    case "maxTurns": {
      const num = Number(v);
      if (!Number.isInteger(num)) {
        throw new Error(
          `agent-def parse error in ${filename}: maxTurns must be an integer at line ${lineIdx}`,
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
          `agent-def parse error in ${filename}: reviewRequired must be 'true' or 'false' at line ${lineIdx}`,
        );
      }
      return;
    }
    default:
      // Unknown keys are preserved as strings for forward compat but
      // do nothing here — out only has the slots it needs.
      return;
  }
}

/**
 * Validate a parsed def. Throws with a filename-aware error on any
 * violation. Required: name (regex), profile, description. Optional
 * fields are re-checked for type safety in case a caller built the
 * object by hand instead of via parseAgentDefSource.
 */
export function validateAgentDef(def, filename) {
  if (!def || typeof def !== "object") {
    throw new Error(`agent-def validation error in ${filename}: def is not an object`);
  }
  if (typeof def.name !== "string" || !/^[a-z][a-z0-9_-]*$/.test(def.name)) {
    throw new Error(
      `agent-def validation error in ${filename}: name must match /^[a-z][a-z0-9_-]*$/`,
    );
  }
  if (typeof def.profile !== "string" || def.profile === "") {
    throw new Error(`agent-def validation error in ${filename}: profile is required`);
  }
  if (typeof def.description !== "string" || def.description === "") {
    throw new Error(`agent-def validation error in ${filename}: description is required`);
  }
  if (def.tools !== undefined) {
    if (typeof def.tools !== "object" || def.tools === null || Array.isArray(def.tools)) {
      throw new Error(`agent-def validation error in ${filename}: tools must be a plain object`);
    }
    for (const [toolName, decision] of Object.entries(def.tools)) {
      if (!DECISIONS.has(decision)) {
        throw new Error(
          `agent-def validation error in ${filename}: tools.${toolName} must be 'allow', 'ask', or 'deny'`,
        );
      }
    }
  }
  if (def.temperature !== undefined) {
    if (typeof def.temperature !== "number" || !Number.isFinite(def.temperature)) {
      throw new Error(
        `agent-def validation error in ${filename}: temperature must be a finite number`,
      );
    }
  }
  if (def.maxTurns !== undefined) {
    if (!Number.isInteger(def.maxTurns) || def.maxTurns <= 0) {
      throw new Error(
        `agent-def validation error in ${filename}: maxTurns must be a positive integer`,
      );
    }
  }
  if (def.reviewRequired !== undefined && typeof def.reviewRequired !== "boolean") {
    throw new Error(
      `agent-def validation error in ${filename}: reviewRequired must be a boolean`,
    );
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
  const out = {};
  const p = profilePolicy || {};
  const a = agentTools || {};

  for (const [tool, decision] of Object.entries(p)) {
    out[tool] = decision;
  }
  for (const [tool, agentDecision] of Object.entries(a)) {
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
 * error either when the name fails the regex (we refuse to touch the
 * filesystem with an invalid name) or when the file does not exist.
 * Other errors (parse, validate) bubble up with their own messages.
 */
export async function loadAgentDef(cwd, name) {
  if (typeof name !== "string" || !/^[a-z][a-z0-9_-]*$/.test(name)) {
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
 * Returns [] if the directory does not exist. Uses readdir (not
 * readFile) so we get a real directory listing instead of an EISDIR.
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
    const filePath = resolve(agentsDir, entry);
    let source;
    try {
      source = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    try {
      const def = parseAgentDefSource(source, entry);
      validateAgentDef(def, entry);
      out.push({ name: def.name, description: def.description });
    } catch {
      // Skip malformed files silently.
    }
  }
  return out;
}
