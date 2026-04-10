// edit_file — exact string replacement in a file inside the sandbox.
// Modeled on Claude Code's Edit tool: old_string must be unique, or
// replace_all must be true. Fails cleanly if the file doesn't exist.

import { readFile, writeFile, stat } from "node:fs/promises";

// When an exact match fails, it is almost always because of whitespace
// drift: the sub-agent guessed the wrong indent, or we mixed CRLF/LF, or
// a trailing space differs. Without a hint, a model can burn 10+ turns
// retrying with slight variations. This helper re-runs the search
// ignoring whitespace, and if it finds a likely region, returns the
// actual file content so the sub-agent can see the exact bytes to match.
function diagnoseMismatch(original, oldString) {
  const normalize = (s) => s.replace(/\s+/g, " ").trim();
  const target = normalize(oldString);
  if (!target) return null;

  const origLines = original.split("\n");
  const oldLines = oldString.split("\n");

  // Anchor on the longest non-blank line of old_string — that line is
  // most likely to be distinctive enough to locate uniquely in the file.
  const anchor = [...oldLines]
    .filter((l) => l.trim())
    .sort((a, b) => b.trim().length - a.trim().length)[0];
  if (!anchor) return null;
  const anchorNorm = normalize(anchor);
  const anchorIdxInOld = oldLines.findIndex((l) => normalize(l) === anchorNorm);

  const hits = [];
  for (let i = 0; i < origLines.length; i++) {
    if (normalize(origLines[i]) === anchorNorm) hits.push(i);
  }
  if (hits.length === 0) return null;

  const regions = [];
  for (const hit of hits.slice(0, 3)) {
    const start = Math.max(0, hit - anchorIdxInOld);
    const end = Math.min(origLines.length, start + oldLines.length);
    const actual = origLines.slice(start, end).join("\n");
    regions.push(`— lines ${start + 1}..${end} of the file:\n${actual}`);
  }
  return regions.join("\n\n");
}

export default {
  name: "Edit",
  description:
    "Edit a file inside the agent's sandbox by replacing an exact string. The old_string must appear exactly once in the file, unless replace_all is true. Preserves file encoding (UTF-8).",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path relative to the sandbox root.",
      },
      old_string: {
        type: "string",
        description:
          "Exact text to replace. Must appear exactly once unless replace_all is true.",
      },
      new_string: {
        type: "string",
        description: "Text to insert in place of old_string.",
      },
      replace_all: {
        type: "boolean",
        description: "If true, replace every occurrence of old_string.",
        default: false,
      },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const { sandbox } = ctx;
    const target = sandbox.resolvePath(args.path);
    let st;
    try {
      st = await stat(target);
    } catch {
      return { content: `Error: file does not exist: ${args.path}`, isError: true };
    }
    if (!st.isFile()) {
      return { content: `Error: not a regular file: ${args.path}`, isError: true };
    }
    if (args.old_string === args.new_string) {
      return { content: `Error: old_string and new_string are identical`, isError: true };
    }

    const original = await readFile(target, "utf8");
    const replaceAll = args.replace_all === true;

    let updated;
    let count;
    if (replaceAll) {
      const parts = original.split(args.old_string);
      count = parts.length - 1;
      if (count === 0) {
        const hint = diagnoseMismatch(original, args.old_string);
        return {
          content:
            `Error: old_string not found in ${args.path}.` +
            (hint
              ? `\n\nA region with the same content (ignoring whitespace) was found. The file actually contains:\n${hint}\n\nCheck indentation, tabs vs spaces, and trailing whitespace carefully.`
              : ""),
          isError: true,
        };
      }
      updated = parts.join(args.new_string);
    } else {
      const first = original.indexOf(args.old_string);
      if (first === -1) {
        const hint = diagnoseMismatch(original, args.old_string);
        return {
          content:
            `Error: old_string not found in ${args.path}.` +
            (hint
              ? `\n\nA region with the same content (ignoring whitespace) was found. The file actually contains:\n${hint}\n\nCheck indentation, tabs vs spaces, and trailing whitespace carefully.`
              : ""),
          isError: true,
        };
      }
      const second = original.indexOf(args.old_string, first + args.old_string.length);
      if (second !== -1) {
        return {
          content: `Error: old_string is not unique in ${args.path} (found at positions ${first} and ${second}). Provide more context or set replace_all.`,
          isError: true,
        };
      }
      updated =
        original.slice(0, first) +
        args.new_string +
        original.slice(first + args.old_string.length);
      count = 1;
    }

    await writeFile(target, updated, "utf8");

    // If the file is open in the workspace, update its content so the next
    // system prompt injection reflects the edit (ADR 0010). threadMgr is
    // optional so this tool keeps working in test harnesses that don't wire it.
    const { thread, threadMgr } = ctx;
    if (threadMgr && thread?.openFiles?.[args.path] !== undefined) {
      const openFiles = {
        ...(thread.openFiles),
        [args.path]: { content: updated, openedAt: thread.openFiles[args.path].openedAt },
      };
      await threadMgr.updateThread(thread.id, { openFiles });
      Object.assign(thread, { openFiles });
    }

    return { content: `Edited ${args.path} (${count} replacement${count === 1 ? "" : "s"}).` };
  },
};
