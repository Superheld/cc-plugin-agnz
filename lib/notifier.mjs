// Platform-specific OS notification shim for ADR 0002 §6c.
//
// Only urgent messages addressed to the parent trigger a notify() call;
// see event-bus.mjs. This module is fire-and-forget by design: a missing
// `osascript` or `notify-send` must never throw out of notify(), and the
// event-bus never awaits the returned promise. A failed notification is
// strictly a degraded-UX condition, not a delivery failure — the message
// is still durable in messages.jsonl.

import { spawn } from "node:child_process";

/**
 * Display an OS notification.
 * - macOS: `osascript -e 'display notification "body" with title "title"'`
 * - Linux: `notify-send <title> <body>`
 * - Other: silent no-op
 *
 * Strings are escaped for AppleScript on macOS. Linux uses argv directly
 * so no escaping is required. spawn() is used (never exec) so the shell
 * is never invoked — no injection risk even with hostile input.
 *
 * @param {{ title: string, body: string }} options
 */
export async function notify({ title, body }) {
  try {
    if (process.platform === "darwin") {
      const t = escapeAppleScript(String(title ?? ""));
      const b = escapeAppleScript(String(body ?? ""));
      spawn(
        "osascript",
        ["-e", `display notification "${b}" with title "${t}"`],
        { stdio: "ignore", detached: true },
      ).on("error", () => {});
      return;
    }
    if (process.platform === "linux") {
      spawn("notify-send", [String(title ?? ""), String(body ?? "")], {
        stdio: "ignore",
        detached: true,
      }).on("error", () => {});
      return;
    }
    // Other platforms: silent no-op.
  } catch (err) {
    process.stderr.write(`notifier: ${err?.message || err}\n`);
  }
}

// AppleScript string literals use double quotes and support backslash
// escapes. We therefore need to escape backslash FIRST (otherwise our
// own added backslashes would get re-escaped), then the quote.
function escapeAppleScript(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
