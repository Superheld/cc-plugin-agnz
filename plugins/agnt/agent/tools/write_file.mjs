// write_file — create a new file (or overwrite an existing one) inside
// the sandbox. Defaults to refusing to overwrite an existing file: the
// agent has to explicitly opt in via overwrite=true so an accidental
// path collision can't silently destroy work.

import { mkdir, stat, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_BYTES = 1 * 1024 * 1024; // 1 MiB cap on a single write — same
                                   // order of magnitude as our read cap.

export default {
  name: "write_file",
  description:
    "Create a new file inside the agent's sandbox, or overwrite an existing one (only if overwrite=true). Parent directories are created automatically. Use edit_file for partial changes to existing files.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path relative to the sandbox root.",
      },
      content: {
        type: "string",
        description: "Full file content to write (UTF-8).",
      },
      overwrite: {
        type: "boolean",
        description:
          "If true, replace the file if it already exists. If false (default), the call fails when the target exists — use edit_file for partial changes instead.",
        default: false,
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const { sandbox } = ctx;

    if (typeof args.content !== "string") {
      return { content: "Error: content must be a string", isError: true };
    }
    const bytes = Buffer.byteLength(args.content, "utf8");
    if (bytes > MAX_BYTES) {
      return {
        content: `Error: content too large (${bytes} bytes, max ${MAX_BYTES})`,
        isError: true,
      };
    }

    const target = sandbox.resolvePath(args.path);

    // Refuse to clobber unless explicitly told to. Agents that don't read
    // before writing should not be able to silently destroy state.
    let existed = false;
    try {
      const st = await stat(target);
      existed = true;
      if (!st.isFile()) {
        return {
          content: `Error: path exists and is not a regular file: ${args.path}`,
          isError: true,
        };
      }
      if (args.overwrite !== true) {
        return {
          content: `Error: ${args.path} already exists. Pass overwrite=true to replace it, or use edit_file for partial changes.`,
          isError: true,
        };
      }
    } catch {
      // Doesn't exist — fine, fall through to create.
    }

    // Make sure the parent dir exists. Sandbox.resolvePath has already
    // verified that target is inside the sandbox root, so the recursive
    // mkdir is bounded.
    await mkdir(dirname(target), { recursive: true });
    await fsWriteFile(target, args.content, "utf8");

    return {
      content: `${existed ? "Overwrote" : "Wrote"} ${args.path} (${bytes} bytes).`,
    };
  },
};
