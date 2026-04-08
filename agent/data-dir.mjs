// Resolve agnz data directories consistently across the MCP server
// and slash-command tooling.
//
// Since ADR 0001 there are TWO separate data roots with distinct
// lifetimes and scopes:
//
//   userDir     — user-wide, cross-project state. Profiles, global memory,
//                 (future) user-wide agent library. One per machine.
//   projectDir  — per-project workspace. Threads, messages, board, cursors,
//                 per-project agents, scratch. One per cwd.
//
// Why split: profiles and global memory are personal infrastructure —
// they should survive plugin updates AND be usable across any project.
// Everything else is work-in-progress that belongs WITH the code it
// operates on and should be editable/versionable by the user.
//
// Resolution for the user dir:
//   1. $AGNZ_DATA_DIR (legacy name, kept for tests and backward compat)
//   2. ~/.claude/agnz  (the new default — co-located with other CC state)
//   3. Fallback read from ~/.local/share/agnz (the old XDG default)
//      if it exists and the new location does not yet. This is a
//      transitional courtesy for users upgrading from 0.3.x.
//
// Resolution for the project dir:
//   projectDir(cwd) = <cwd>/.claude/agnz
//
// Tests can isolate per-project state by pointing cwd at a temp dir.
// There is no project-scope env override because it would encourage
// detaching project state from the code it belongs to.

import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

/**
 * User-wide data directory: profiles, global memory.
 * Stable across projects and plugin versions.
 */
export function resolveUserDir() {
  if (process.env.AGNZ_DATA_DIR) {
    return resolve(process.env.AGNZ_DATA_DIR);
  }
  const newDefault = resolve(homedir(), ".claude", "agnz");
  if (existsSync(newDefault)) {
    return newDefault;
  }
  // Transitional: if the old XDG location has content and the new one
  // doesn't yet, keep reading from the old one so users don't lose their
  // profiles on the 0.3.x → 0.4.0 upgrade. A one-shot migration helper
  // will move them in a later step.
  const legacy = resolve(homedir(), ".local", "share", "agnz");
  if (existsSync(legacy)) {
    return legacy;
  }
  return newDefault;
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

/**
 * @deprecated Use resolveUserDir() or resolveProjectDir(cwd) instead.
 * Kept as an alias during the 0.3.x → 0.4.0 transition so existing
 * consumers (memory, threads, profiles) keep working until they are
 * migrated one at a time. Will be removed once all consumers are
 * updated and the migration is complete.
 */
export function resolveDataDir() {
  return resolveUserDir();
}
