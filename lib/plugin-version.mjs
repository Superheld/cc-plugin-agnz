// The running plugin version, read from the manifest.
//
// Exists because the system prompt is a frozen, write-once snapshot (ADR 0012):
// a thread keeps the prompt it was born with for its whole life, so a prompt
// fix reaches existing threads never. That is the intended trade (a stable
// prefix is what the inference server caches), but it used to be invisible —
// a thread could be running a months-old prompt with no way to tell from the
// outside. Stamping the version at snapshot time makes the drift observable.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

let cached = null;

/**
 * Read the plugin's declared version. Cached per process; a failure to read
 * the manifest is never fatal — this is diagnostics, not control flow.
 *
 * @param {string} pluginRoot — the plugin's root directory
 * @returns {Promise<string>} the version, or "unknown"
 */
export async function readPluginVersion(pluginRoot) {
  if (cached) return cached;
  if (!pluginRoot) return "unknown";
  try {
    const raw = await readFile(resolve(pluginRoot, ".claude-plugin", "plugin.json"), "utf8");
    cached = JSON.parse(raw).version || "unknown";
  } catch {
    cached = "unknown";
  }
  return cached;
}
