// grep — recursive content search inside the sandbox. Native Node only,
// no shelling out to ripgrep. Returns matches as `path:line: text` lines,
// capped to keep the LLM context bounded.
//
// Design notes:
// - Default mode is regex (JavaScript flavour). Pass `literal: true` to
//   treat the pattern as a fixed string.
// - Skips obviously-binary files (NUL byte in first 8 KiB) and skips
//   common noise dirs (.git, node_modules) so the agent doesn't drown in
//   vendor results.
// - Hard caps on file size, total files visited, and result lines so a
//   pathological invocation can't blow context or memory.

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  ".next",
  ".cache",
]);
const MAX_FILE_BYTES = 512 * 1024;   // skip files larger than 512 KiB
const MAX_FILES_VISITED = 5000;      // visit at most 5k files
const DEFAULT_MAX_RESULTS = 100;     // 100 result lines unless override
const HARD_MAX_RESULTS = 500;        // upper bound regardless of arg

export default {
  name: "Grep",
  description:
    "Search files for a pattern. Returns path:line:content matches. Regex by default; literal=true for plain strings.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regex or literal search string.",
      },
      path: {
        type: "string",
        description: "Directory to search. Default '.'.",
        default: ".",
      },
      include: {
        type: "string",
        description: "Filename glob filter (e.g. '*.mjs', '*.{ts,tsx}').",
      },
      literal: {
        type: "boolean",
        description: "Treat pattern as plain string.",
        default: false,
      },
      case_insensitive: {
        type: "boolean",
        description: "Case-insensitive match.",
        default: false,
      },
      max_results: {
        type: "number",
        description: `Result limit. Default ${DEFAULT_MAX_RESULTS}, max ${HARD_MAX_RESULTS}.`,
        default: DEFAULT_MAX_RESULTS,
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const { sandbox, signal } = ctx;

    if (typeof args.pattern !== "string" || !args.pattern) {
      return { content: "Error: pattern is required", isError: true };
    }

    const root = sandbox.resolvePath(args.path || ".");
    let rootStat;
    try {
      rootStat = await stat(root);
    } catch {
      return { content: `Error: path does not exist: ${args.path || "."}`, isError: true };
    }
    if (!rootStat.isDirectory()) {
      return { content: `Error: not a directory: ${args.path || "."}`, isError: true };
    }

    let regex;
    try {
      const flags = args.case_insensitive === true ? "i" : "";
      const source = args.literal === true ? escapeRegex(args.pattern) : args.pattern;
      regex = new RegExp(source, flags);
    } catch (err) {
      return { content: `Error: invalid regex: ${err.message}`, isError: true };
    }

    const cap = Math.min(
      Math.max(1, Number(args.max_results) || DEFAULT_MAX_RESULTS),
      HARD_MAX_RESULTS,
    );

    // Compile include glob to a regex if provided.
    let includeRegex = null;
    if (args.include && typeof args.include === "string") {
      includeRegex = globToRegex(args.include);
    }

    const results = [];
    const stats = { filesVisited: 0, filesMatched: 0, truncated: false };
    const sandboxRoot = sandbox.getRoot();

    await walk(root, async (filePath) => {
      // Abort between files so a hard-interrupt can stop a runaway grep. (A
      // pathological regex on a single huge line is still synchronous and not
      // interruptible — that needs a regex-timeout, out of scope here.)
      if (signal?.aborted) {
        stats.truncated = true;
        return false;
      }
      if (stats.filesVisited >= MAX_FILES_VISITED) {
        stats.truncated = true;
        return false;
      }
      stats.filesVisited++;

      let st;
      try {
        st = await stat(filePath);
      } catch {
        return true;
      }
      if (!st.isFile()) return true;
      if (st.size === 0) return true;
      if (st.size > MAX_FILE_BYTES) return true;
      if (includeRegex && !includeRegex.test(filePath.split("/").pop())) return true;

      let buf;
      try {
        buf = await readFile(filePath);
      } catch {
        return true;
      }
      // Cheap binary detection: NUL byte in first 8 KiB.
      const sniff = buf.subarray(0, Math.min(buf.length, 8192));
      if (sniff.includes(0)) return true;

      const text = buf.toString("utf8");
      const lines = text.split("\n");
      const rel = relative(sandboxRoot, filePath) || ".";

      let matchedThisFile = false;
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matchedThisFile = true;
          // Truncate very long lines so a single match can't dominate.
          const line = lines[i].length > 240 ? lines[i].slice(0, 240) + "…" : lines[i];
          results.push(`${rel}:${i + 1}: ${line}`);
          if (results.length >= cap) {
            stats.truncated = true;
            return false;
          }
        }
      }
      if (matchedThisFile) stats.filesMatched++;
      return true;
    });

    if (results.length === 0) {
      return {
        content: `No matches for /${args.pattern}/ in ${args.path || "."} (visited ${stats.filesVisited} files).`,
      };
    }

    const header = `Found ${results.length} match${results.length === 1 ? "" : "es"} in ${stats.filesMatched} file${stats.filesMatched === 1 ? "" : "s"}${stats.truncated ? " (truncated)" : ""}.`;
    return { content: `${header}\n${results.join("\n")}` };
  },
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convert a simple glob pattern (*, ?, {a,b}) to a RegExp matched against
 * the filename only. Supports: * (any chars), ? (one char), {a,b} (alternation).
 */
function globToRegex(glob) {
  // Handle {a,b,c} alternation first, then escape and expand * / ?
  const src = glob
    .replace(/\{([^}]+)\}/g, (_, inner) => `(${inner.split(",").map(s => escapeRegex(s.trim())).join("|")})`)
    .replace(/\./g, "\\.")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${src}$`, "i");
}

/**
 * Walk a directory tree, calling visit(filePath) for each entry. Skips
 * common vendor / VCS dirs. visit() may return false to stop the walk.
 */
async function walk(dir, visit) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return true;
  }
  // Sort for deterministic output across runs.
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of entries) {
    if (ent.name.startsWith(".") && ent.name !== "." && ent.name !== "..") {
      // Allow .env, .gitignore, etc. — only skip dot dirs that match the
      // skip list. Hidden files are still searched.
      if (ent.isDirectory() && SKIP_DIRS.has(ent.name)) continue;
    }
    if (ent.isDirectory() && SKIP_DIRS.has(ent.name)) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      const cont = await walk(full, visit);
      if (cont === false) return false;
    } else {
      const cont = await visit(full);
      if (cont === false) return false;
    }
  }
  return true;
}
