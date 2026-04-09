// Resolve agnz data directories consistently across the MCP server
// and slash-command tooling.
//
// Since ADR 0001 there are TWO separate data roots with distinct
// lifetimes and scopes:
//
//   userDir     — user-wide, cross-project state. Profiles and the
//                 (future) user-wide agent library. One per machine.
//   projectDir  — per-project workspace. Threads, messages, board, cursors,
//                 per-project agents, scratch. One per cwd.
//
// Why split: profiles are personal infrastructure — they should survive
// plugin updates AND be usable across any project. Everything else is
// work-in-progress that belongs WITH the code it operates on and should
// be editable/versionable by the user.
//
// Resolution for the user dir:
//   1. $AGNZ_DATA_DIR (kept for tests and development overrides)
//   2. ~/.claude/agnz  (the default — co-located with other CC state)
//
// Resolution for the project dir:
//   projectDir(cwd) = <cwd>/.claude/agnz
//
// Tests can isolate per-project state by pointing cwd at a temp dir.

import { resolve } from "node:path";
import { homedir } from "node:os";

/**
 * User-wide data directory: profiles and other cross-project user
 * settings. Stable across projects and plugin versions.
 */
export function resolveUserDir() {
  if (process.env.AGNZ_DATA_DIR) {
    return resolve(process.env.AGNZ_DATA_DIR);
  }
  return resolve(homedir(), ".claude", "agnz");
}

/**
 * Per-project workspace directory: threads, messages, board, cursors.
 * Lives inside the project's .claude/ area so it is co-located with
 * other Claude Code project state and naturally version-controllable.
 *
 * @param {string} cwd — absolute path to the project root
 */
export function resolveProjectDir(cwd) {
  if (!cwd) throw new Error("resolveProjectDir: cwd is required");
  return resolve(cwd, ".claude", "agnz");
}
