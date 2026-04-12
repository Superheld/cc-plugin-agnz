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
    "Replace exact text in a file. old_string must appear exactly once unless replace_all=true. If not found, re-read with Read first — do not retry with the same string.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path.",
      },
      old_string: {
        type: "string",
        description: "Exact text to replace.",
      },
      new_string: {
        type: "string",
        description: "Replacement text.",
      },
      replace_all: {
        type: "boolean",
        description: "Replace every occurrence.",
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
              : `\n\nThe anchor text was not found anywhere in the file — it may have been modified or already applied. Use Read to re-read the current content of ${args.path} before retrying.`),
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
              : `\n\nThe anchor text was not found anywhere in the file — it may have been modified or already applied. Use Read to re-read the current content of ${args.path} before retrying.`),
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
    return { content: `Edited ${args.path} (${count} replacement${count === 1 ? "" : "s"}).` };
  },
};
