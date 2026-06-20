// edit_file — locate a content anchor in a file and replace it, or insert
// text before/after it.
//
// The anchor (old_string) is CONTENT, not a line range: it is matched
// against the current file bytes, so it survives line drift (a concurrent
// agent's edit, or a prior edit in the same turn) and fails LOUDLY when it
// no longer matches, rather than silently corrupting the wrong lines. The
// exact-match anchor is also the proof that the agent read the region
// before changing it — no separate read-tracking is needed.
//
// Extensions over the plain Claude-Code Edit:
//   - mode: "replace" (default) | "after" | "before" — insert relative to
//     the anchor without restating it in new_string
//   - line: optional 1-based hint to disambiguate a non-unique anchor; the
//     occurrence nearest the hint wins instead of erroring
//   - tolerance for Read's "  NN  " line-number prefix, so the agent can
//     paste lines straight from Read output as the anchor

import { readFile, stat } from "node:fs/promises";
import { atomicWriteFile } from "../atomic-write.mjs";
import { withFileLock } from "../file-lock.mjs";

// When an exact match fails, it is almost always whitespace drift: the
// sub-agent guessed the wrong indent, mixed CRLF/LF, or a trailing space
// differs. This helper re-runs the search ignoring whitespace and, if it
// finds a likely region, returns the actual file content so the sub-agent
// can see the exact bytes to match.
function diagnoseMismatch(original, oldString) {
  const normalize = (s) => s.replace(/\s+/g, " ").trim();
  const target = normalize(oldString);
  if (!target) return null;

  const origLines = original.split("\n");
  const oldLines = oldString.split("\n");

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

// Strip Read's line-number prefix ("   42  ") from each line, so an anchor
// pasted straight from Read output still matches the raw file bytes.
function stripLineNumberPrefix(s) {
  return s.split("\n").map((l) => l.replace(/^ *\d+ {2}/, "")).join("\n");
}

function findOccurrences(haystack, needle) {
  const idxs = [];
  if (!needle) return idxs;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    idxs.push(i);
    i = haystack.indexOf(needle, i + needle.length);
  }
  return idxs;
}

function lineOfIndex(haystack, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < haystack.length; i++) {
    if (haystack[i] === "\n") line++;
  }
  return line;
}

export default {
  name: "Edit",
  description:
    "Find a content anchor (old_string) in a file and replace it (mode=replace, default) or insert new_string before/after it (mode=before|after). The anchor must match the current file exactly — you can paste lines straight from Read (the line-number prefix is tolerated). Keep the anchor small but unique; if it occurs more than once, pass `line` (1-based) to pick the nearest occurrence.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path." },
      old_string: {
        type: "string",
        description:
          "Content anchor to locate. Small but unique. Read-output line-number prefixes are tolerated.",
      },
      new_string: {
        type: "string",
        description: "Replacement text (mode=replace), or text to insert (mode=before|after).",
      },
      mode: {
        type: "string",
        enum: ["replace", "before", "after"],
        description: "replace the anchor (default), or insert new_string before/after it.",
        default: "replace",
      },
      line: {
        type: "integer",
        description: "1-based line hint to disambiguate a non-unique anchor; the nearest occurrence wins.",
        minimum: 1,
      },
      replace_all: {
        type: "boolean",
        description: "Replace every occurrence (mode=replace only).",
        default: false,
      },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const { sandbox } = ctx;
    const target = sandbox.resolvePath(args.path);
    // Serialise the whole read-modify-write per file so two concurrent
    // edits (or an edit racing a Write) cannot lose an update.
    return withFileLock(target, async () => {
      let st;
      try {
        st = await stat(target);
      } catch {
        return { content: `Error: file does not exist: ${args.path}`, isError: true };
      }
      if (!st.isFile()) {
        return { content: `Error: not a regular file: ${args.path}`, isError: true };
      }

      const mode = args.mode || "replace";
      if (mode === "replace" && args.old_string === args.new_string) {
        return { content: `Error: old_string and new_string are identical`, isError: true };
      }

      const original = await readFile(target, "utf8");

      // Locate the anchor. Try it verbatim; if that misses, retry with
      // Read's line-number prefix stripped so a pasted Read slice matches.
      let anchor = args.old_string;
      let idxs = findOccurrences(original, anchor);
      if (idxs.length === 0) {
        const stripped = stripLineNumberPrefix(args.old_string);
        if (stripped !== args.old_string) {
          const sIdxs = findOccurrences(original, stripped);
          if (sIdxs.length > 0) {
            anchor = stripped;
            idxs = sIdxs;
          }
        }
      }

      if (idxs.length === 0) {
        const hint = diagnoseMismatch(original, stripLineNumberPrefix(args.old_string));
        return {
          content:
            `Error: anchor not found in ${args.path}.` +
            (hint
              ? `\n\nClosest region (ignoring whitespace), the file actually contains:\n${hint}\n\nMatch indentation, tabs vs spaces, and trailing whitespace exactly.`
              : `\n\nThe anchor was not found anywhere — the file may have changed. Read ${args.path} again before retrying.`),
          isError: true,
        };
      }

      // replace_all: only meaningful for replace mode.
      if (mode === "replace" && args.replace_all === true) {
        const updated = original.split(anchor).join(args.new_string);
        await atomicWriteFile(target, updated);
        return {
          content: `Edited ${args.path} (${idxs.length} replacement${idxs.length === 1 ? "" : "s"}).`,
        };
      }

      // Pick the target occurrence.
      let pos;
      if (idxs.length === 1) {
        pos = idxs[0];
      } else if (typeof args.line === "number") {
        pos = idxs.reduce((best, idx) =>
          Math.abs(lineOfIndex(original, idx) - args.line) <
          Math.abs(lineOfIndex(original, best) - args.line)
            ? idx
            : best,
        );
      } else {
        return {
          content: `Error: anchor is not unique in ${args.path} (${idxs.length} occurrences). Add surrounding context to the anchor, or pass a 'line' hint to pick the nearest.`,
          isError: true,
        };
      }

      let updated;
      if (mode === "after") {
        const end = pos + anchor.length;
        updated = original.slice(0, end) + args.new_string + original.slice(end);
      } else if (mode === "before") {
        updated = original.slice(0, pos) + args.new_string + original.slice(pos);
      } else {
        updated = original.slice(0, pos) + args.new_string + original.slice(pos + anchor.length);
      }
      await atomicWriteFile(target, updated);
      const verb = mode === "replace" ? "Edited" : `Inserted ${mode}`;
      return { content: `${verb} ${args.path} (line ${lineOfIndex(original, pos)}).` };
    });
  },
};
