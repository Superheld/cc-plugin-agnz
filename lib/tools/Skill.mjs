// Skill — load project-local skills on demand. See ADR 0005.
//
// Skills live at <cwd>/.claude/skills/<skill-name>/SKILL.md and are
// plain markdown with YAML frontmatter (same format as Claude Code plugin
// skills). The sub-agent calls:
//
//   Skill({ action: "list" })
//     → lists available skills (name + description)
//
//   Skill({ action: "load", name: "commit-style" })
//     → returns the body of that skill's SKILL.md (frontmatter stripped)
//
// Default policy: allow. Read-only, reads only from pre-defined paths,
// no path-traversal risk.
//
// Discovery is lazy and cached per thread: the first call within a thread
// reads the skills directory; subsequent calls within the same thread reuse
// the cached catalog. This avoids readdir latency on every tool call while
// still picking up edits made before the thread started.
//
// The allowList comes from the agent def's `skills:` sequence (ADR 0005 §4).
// If absent, all project-local skills are exposed. Unknown skill names in
// the allowList are silently omitted from the list result.

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";

// Cache: threadId → Map<skillName, { description, body }>
const catalogCache = new Map();

/**
 * Parse a SKILL.md source into { name, description, body }. We only
 * need `name` and `description` from the frontmatter; the body is
 * everything after the closing `---` fence. This is a deliberately
 * minimal parser — only enough for the V1 SKILL.md shape.
 */
function parseSkillMd(source, dirName) {
  const lines = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length || lines[i].trim() !== "---") {
    // No frontmatter — treat the whole file as the body, use dirName as name.
    return { name: dirName, description: "", body: source.trim() };
  }
  i++; // consume opening fence

  let name = dirName;
  let description = "";

  while (i < lines.length && lines[i].trim() !== "---") {
    const trimmed = lines[i].trim();
    if (trimmed === "") { i++; continue; }

    const kv = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) { i++; continue; } // skip unsupported constructs
    if (kv[1] === "name" && kv[2].trim()) name = kv[2].trim();
    if (kv[1] === "description" && kv[2].trim()) description = kv[2].trim();
    i++;
  }

  if (i < lines.length && lines[i].trim() === "---") i++; // consume closing fence
  const body = lines.slice(i).join("\n").trim();
  return { name, description, body };
}

/**
 * Discover all skills across the three standard locations.
 * Lowest-to-highest priority so project-local wins on name clash.
 * Returns a Map keyed by skill name → { description, body }.
 */
async function discoverSkills(cwd, pluginRoot) {
  const roots = [
    ...(pluginRoot ? [resolve(pluginRoot, "skills")] : []),
    resolve(homedir(), ".claude", "skills"),
    resolve(cwd, ".claude", "skills"),
  ];

  const catalog = new Map();
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = resolve(root, entry.name, "SKILL.md");
      let source;
      try {
        source = await readFile(skillPath, "utf8");
      } catch {
        continue;
      }
      const { name, description, body } = parseSkillMd(source, entry.name);
      catalog.set(name, { description, body });
    }
  }
  return catalog;
}

export default {
  name: "Skill",
  description:
    "Load project skills. action=list shows available skills; action=load returns content.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "load"],
        description: "list or load.",
      },
      name: {
        type: "string",
        description: "Skill name (required for load).",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const { thread, pluginRoot } = ctx;
    const threadId = thread.id;
    const cwd = thread.cwd;
    const allowList = thread.agentDef?.skills ?? null; // null = no restriction

    // Lazy per-thread catalog discovery.
    let catalog = catalogCache.get(threadId);
    if (!catalog) {
      catalog = await discoverSkills(cwd, pluginRoot);
      catalogCache.set(threadId, catalog);
    }

    // Apply allowList: if the agent def named specific skills, expose only those.
    // Unknown names in the allowList are silently omitted.
    const available =
      allowList === null
        ? catalog
        : new Map(allowList.filter((n) => catalog.has(n)).map((n) => [n, catalog.get(n)]));

    if (args.action === "list") {
      if (available.size === 0) {
        return { content: "No skills available." };
      }
      const lines = [...available.entries()].map(([n, s]) =>
        s.description ? `- ${n}: ${s.description}` : `- ${n}`,
      );
      return { content: `Available skills:\n${lines.join("\n")}` };
    }

    if (args.action === "load") {
      const name = args.name;
      if (typeof name !== "string" || !name.trim()) {
        return { content: "Error: name is required when action=load", isError: true };
      }
      const skill = available.get(name);
      if (!skill) {
        const suggestions = [...available.keys()].join(", ") || "none";
        return {
          content: `Error: skill '${name}' not found. Available: ${suggestions}`,
          isError: true,
        };
      }
      return { content: skill.body };
    }

    return { content: `Error: unknown action '${args.action}' (expected list or load)`, isError: true };
  },
};
