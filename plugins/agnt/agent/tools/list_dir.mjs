// list_dir — enumerate the contents of a directory within the sandbox.
// Returns a compact listing with file/dir marker and size.

import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

export default {
  name: "list_dir",
  description:
    "List the contents of a directory inside the agent's sandbox. Returns a newline-separated list where each line is either 'd <name>' for directories or 'f <name> <size>' for files. Paths are relative to the sandbox root.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Directory to list, relative to the sandbox root. Use '.' for the root itself.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const { sandbox } = ctx;
    const target = sandbox.resolvePath(args.path || ".");
    const entries = await readdir(target, { withFileTypes: true });
    const lines = [];
    for (const e of entries) {
      const full = join(target, e.name);
      if (e.isDirectory()) {
        lines.push(`d ${e.name}`);
      } else if (e.isFile()) {
        try {
          const st = await stat(full);
          lines.push(`f ${e.name} ${st.size}`);
        } catch {
          lines.push(`f ${e.name} ?`);
        }
      } else if (e.isSymbolicLink()) {
        lines.push(`l ${e.name}`);
      } else {
        lines.push(`? ${e.name}`);
      }
    }
    lines.sort();
    const rel = relative(sandbox.getRoot(), target) || ".";
    return {
      content: `Contents of ${rel} (${lines.length} entries):\n${lines.join("\n")}`,
    };
  },
};
