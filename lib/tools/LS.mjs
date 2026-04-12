// list_dir — enumerate the contents of a directory within the sandbox.
// Returns a compact listing with file/dir marker and size.
// With depth > 1, expands subdirectories recursively up to that depth.

import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", ".cache"]);

export default {
  name: "LS",
  description:
    "List the contents of a directory inside the agent's sandbox. Returns a newline-separated list where each line is 'd <path>' for directories or 'f <path> <size>' for files. Paths are relative to the sandbox root. Use depth > 1 to expand subdirectories recursively (max 5).",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Directory to list, relative to the sandbox root. Use '.' for the root itself.",
      },
      depth: {
        type: "integer",
        description: "How many levels deep to expand subdirectories. Default 1 (flat listing). Max 5.",
        minimum: 1,
        maximum: 5,
        default: 1,
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const { sandbox } = ctx;
    const target = sandbox.resolvePath(args.path || ".");
    const maxDepth = Math.min(Math.max(1, args.depth ?? 1), 5);
    const sandboxRoot = sandbox.getRoot();
    const lines = [];

    async function collect(dir, currentDepth) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        const full = join(dir, e.name);
        const rel = relative(sandboxRoot, full) || ".";
        if (e.isDirectory()) {
          const skip = SKIP_DIRS.has(e.name);
          lines.push(`d ${rel}${skip ? " (skipped)" : ""}`);
          if (!skip && currentDepth < maxDepth) {
            await collect(full, currentDepth + 1);
          }
        } else if (e.isFile()) {
          try {
            const st = await stat(full);
            lines.push(`f ${rel} ${st.size}`);
          } catch {
            lines.push(`f ${rel} ?`);
          }
        } else if (e.isSymbolicLink()) {
          lines.push(`l ${rel}`);
        }
      }
    }

    await collect(target, 1);
    const rel = relative(sandboxRoot, target) || ".";
    return {
      content: `Contents of ${rel} (${lines.length} entries):\n${lines.join("\n")}`,
    };
  },
};
