// Read — read a UTF-8 text file inside the sandbox, optionally a slice.
//
// Workspace model (ADR 0010):
// Full reads (no start_line / end_line) are stored in thread.openFiles so
// buildMessages() can inject the content into the system prompt every turn.
// The tool result is a short acknowledgement — the agent sees the actual
// content in the Workspace section of the next system prompt.
// Partial reads (start_line / end_line) behave as before: content is returned
// directly in the tool result and is NOT stored in the workspace.

import { readFile as fsReadFile, stat } from "node:fs/promises";
import { appendTrace } from "../trace.mjs";

const MAX_BYTES = 512 * 1024;    // hard cap per read (same as before)
const OPEN_FILE_MAX = 100 * 1024; // files larger than this are NOT opened into
                                   // workspace (content returned in tool result)

export default {
  name: "Read",
  description:
    "Read a UTF-8 text file inside the sandbox. A full read (no start_line/end_line) opens the file in the workspace: its content appears as a dedicated message before the conversation and stays current automatically after every Edit or Write — no need to re-read. A partial read (start_line/end_line) returns the slice directly without opening the file.",
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
    const { sandbox, thread, threadMgr } = ctx;
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
    const isFullRead = args.start_line == null && args.end_line == null;

    // Full read within workspace size limit → open into workspace.
    // The content is stored as raw text; buildMessages formats it with line
    // numbers when injecting into the system prompt.
    if (isFullRead && st.size <= OPEN_FILE_MAX && threadMgr) {
      const openFiles = {
        ...(thread.openFiles || {}),
        [args.path]: { content: raw, openedAt: Date.now() },
      };
      await threadMgr.updateThread(thread.id, { openFiles });
      Object.assign(thread, { openFiles });
      appendTrace(thread, {
        type: "file_opened",
        path: args.path,
        lines: lines.length,
        openFiles: Object.keys(openFiles),
      });
      return {
        content: `[${args.path} opened — ${lines.length} lines injected into workspace context]`,
      };
    }

    // Partial read or file too large for workspace → return content directly.
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
