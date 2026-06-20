// Shared skill discovery — the single source used by BOTH the Skill tool
// (list/load) and the loop's system-prompt catalog injection, so the two
// can never drift.
//
// Skills live at <root>/.claude/skills/<dir>/SKILL.md across three roots:
// plugin-bundled, user-wide (~/.claude/skills), and project-local
// (<cwd>/.claude/skills). The roots are scanned lowest-to-highest priority
// so a project-local skill wins on a name clash. Everything the parent can
// see is therefore visible to the agent, unless the agent def narrows it.

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Parse a SKILL.md source into { name, description, body }. Minimal: name
 * and description from the frontmatter, body is everything after the closing
 * fence. A file without frontmatter is treated as a body, named by its dir.
 */
export function parseSkillMd(source, dirName) {
  const lines = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length || lines[i].trim() !== "---") {
    return { name: dirName, description: "", body: source.trim() };
  }
  i++; // consume opening fence

  let name = dirName;
  let description = "";
  while (i < lines.length && lines[i].trim() !== "---") {
    const trimmed = lines[i].trim();
    if (trimmed === "") { i++; continue; }
    const kv = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) { i++; continue; }
    if (kv[1] === "name" && kv[2].trim()) name = kv[2].trim();
    if (kv[1] === "description" && kv[2].trim()) description = kv[2].trim();
    i++;
  }
  if (i < lines.length && lines[i].trim() === "---") i++; // consume closing fence
  const body = lines.slice(i).join("\n").trim();
  return { name, description, body };
}

/**
 * Discover all skills across the three roots. Returns a Map keyed by skill
 * name → { name, description, body, dir, source }. `dir` is the directory
 * name (which may differ from the frontmatter name); `source` is one of
 * "plugin" | "user" | "project".
 */
export async function discoverSkills(cwd, pluginRoot) {
  const roots = [
    ...(pluginRoot ? [{ dir: resolve(pluginRoot, "skills"), source: "plugin" }] : []),
    { dir: resolve(homedir(), ".claude", "skills"), source: "user" },
    { dir: resolve(cwd, ".claude", "skills"), source: "project" },
  ];

  const catalog = new Map();
  for (const { dir, source } of roots) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = resolve(dir, entry.name, "SKILL.md");
      let src;
      try {
        src = await readFile(skillPath, "utf8");
      } catch {
        continue;
      }
      const parsed = parseSkillMd(src, entry.name);
      catalog.set(parsed.name, { ...parsed, dir: entry.name, source });
    }
  }
  return catalog;
}

/**
 * Does an agent def's `skills:` allow-list permit this entry? A null/absent
 * list means "all skills allowed". The list may name either the frontmatter
 * name or the directory name — both match.
 */
export function skillAllowed(allowList, entry) {
  if (!Array.isArray(allowList)) return true;
  return allowList.includes(entry.name) || allowList.includes(entry.dir);
}
