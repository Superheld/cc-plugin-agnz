// read_file — read a UTF-8 text file inside the sandbox, optionally a slice.

import { readFile as fsReadFile, stat } from "node:fs/promises";

const MAX_BYTES = 512 * 1024; // hard cap per read to protect context

export default {
  name: "read_file",
  description:
    "Read a UTF-8 text file inside the agent's sandbox. Returns the file contents with line numbers prepended. For large files you can request a specific line range.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path relative to the sandbox root.",
      },
      start_line: {
        type: "integer",
        description: "Optional 1-based line number to start from.",
        minimum: 1,
      },
      end_line: {
        type: "integer",
        description: "Optional 1-based line number to end at (inclusive).",
        minimum: 1,
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const { sandbox } = ctx;
    const target = sandbox.resolvePath(args.path);
    const st = await stat(target);
    if (!st.isFile()) {
      return { content: `Error: not a regular file: ${args.path}`, isError: true };
    }
    if (st.size > MAX_BYTES) {
      return {
        content: `Error: file too large (${st.size} bytes > ${MAX_BYTES}). Use start_line/end_line to read a slice.`,
        isError: true,
      };
    }
    const raw = await fsReadFile(target, "utf8");
    const lines = raw.split("\n");
    const start = Math.max(1, args.start_line ?? 1);
    const end = Math.min(lines.length, args.end_line ?? lines.length);
    const slice = lines.slice(start - 1, end);
    const numbered = slice
      .map((l, i) => `${String(start + i).padStart(5, " ")}  ${l}`)
      .join("\n");
    const header = `# ${args.path} (lines ${start}-${end} of ${lines.length})`;
    return { content: `${header}\n${numbered}` };
  },
};
