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

// Count leading-whitespace columns.
const indentOf = (s) => s.length - s.replace(/^\s+/, "").length;

/**
 * Read a YAML block scalar body starting at line `i`. The header line (the
 * one carrying `>` / `|`) was already consumed; `keyIndent` is that header's
 * indent. Collects following lines that are blank or more-indented than the
 * key, stops at the closing `---` or a line at/below the key's indent.
 *
 * `style` "|" keeps newlines (literal); ">" folds (a run of non-blank lines
 * joins with single spaces, a blank line becomes a newline boundary). Real
 * descriptions are the use case, so chomping nuance beyond a final trim is
 * out of scope. Returns [value, nextIndex].
 */
function readBlockScalar(lines, i, keyIndent, style) {
  const collected = [];
  while (i < lines.length && lines[i].trim() !== "---") {
    const raw = lines[i];
    if (raw.trim() === "") { collected.push(""); i++; continue; }
    if (indentOf(raw) <= keyIndent) break;
    collected.push(raw);
    i++;
  }
  while (collected.length && collected[collected.length - 1].trim() === "") collected.pop();

  // Strip the common leading indent shared by the non-blank content lines.
  const contentIndents = collected.filter((l) => l.trim() !== "").map(indentOf);
  const common = contentIndents.length ? Math.min(...contentIndents) : 0;
  const stripped = collected.map((l) => (l.trim() === "" ? "" : l.slice(common)));

  if (style === "|") return [stripped.join("\n"), i];

  // Folded: join within a paragraph with spaces, break paragraphs on blanks.
  let value = "";
  for (const line of stripped) {
    if (line === "") { value += "\n"; continue; }
    if (value !== "" && !value.endsWith("\n")) value += " ";
    value += line;
  }
  return [value, i];
}

/**
 * Parse a SKILL.md source into { name, description, body }. Minimal: name
 * and description from the frontmatter, body is everything after the closing
 * fence. A file without frontmatter is treated as a body, named by its dir.
 *
 * Values may be a plain `key: value` scalar or a YAML block scalar
 * (`key: >` folded / `key: |` literal, including the `-`/`+` chomping
 * variants) whose real content lives on the indented lines below — without
 * this the indicator char alone was leaking through as the value.
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
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === "") { i++; continue; }
    const kv = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) { i++; continue; }
    const key = kv[1];
    const rest = kv[2];

    const block = rest.match(/^([>|])[+-]?\s*$/);
    let value;
    if (block) {
      const [scalar, next] = readBlockScalar(lines, i + 1, indentOf(raw), block[1]);
      value = scalar;
      i = next;
    } else {
      value = rest;
      i++;
    }

    if (key === "name" && value.trim()) name = value.trim();
    if (key === "description" && value.trim()) description = value.trim();
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
