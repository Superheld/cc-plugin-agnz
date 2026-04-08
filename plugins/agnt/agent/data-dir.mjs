// Resolve the agnt data directory consistently across the MCP server
// and the slash-command companion CLI. The defaults are deliberately
// VERSION-INDEPENDENT so threads, profiles, and memory survive plugin
// updates — Claude Code re-caches the plugin into a versioned cache dir
// on every install, and we don't want our state to vanish along with it.
//
// Resolution order:
//   1. $AGNT_DATA_DIR — explicit override (used by tests)
//   2. $XDG_DATA_HOME/agnt — proper XDG layout if set
//   3. ~/.local/share/agnt — XDG default on Linux/macOS

import { resolve } from "node:path";
import { homedir } from "node:os";

export function resolveDataDir() {
  if (process.env.AGNT_DATA_DIR) {
    return resolve(process.env.AGNT_DATA_DIR);
  }
  if (process.env.XDG_DATA_HOME) {
    return resolve(process.env.XDG_DATA_HOME, "agnt");
  }
  return resolve(homedir(), ".local", "share", "agnt");
}
