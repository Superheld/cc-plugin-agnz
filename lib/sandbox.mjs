// Sandbox: scopes all agent file access to a root directory and enforces
// a per-tool permission policy. The sandbox does NOT ask the user directly —
// when a tool requires approval, the agent loop surfaces the pending call
// back up through MCP so the driving Claude session can request consent.

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, relative, sep } from "node:path";

/**
 * Permission decisions.
 *   allow — tool may run without asking
 *   ask   — tool must pause and wait for an explicit approval
 *   deny  — tool is refused outright
 */
export const Decision = Object.freeze({ ALLOW: "allow", ASK: "ask", DENY: "deny" });

/**
 * Build a sandbox rooted at `root`. `root` must exist and be a directory.
 * Symlinks are resolved once at construction; all subsequent path checks are
 * performed against the resolved real path to prevent symlink-escape tricks.
 *
 * Policy is built from the agent def:
 *   - tools (whitelist): allowed
 *   - disallowedTools: denied
 *   - everything else: "ask"
 */
export function createSandbox({ root, policy } = {}) {
  if (!root || typeof root !== "string") {
    throw new Error("sandbox: root is required");
  }
  const absRoot = isAbsolute(root) ? root : resolve(root);
  let realRoot;
  try {
    realRoot = realpathSync(absRoot);
  } catch (err) {
    throw new Error(`sandbox: root does not exist: ${absRoot} (${err.message})`);
  }
  const st = statSync(realRoot);
  if (!st.isDirectory()) {
    throw new Error(`sandbox: root is not a directory: ${realRoot}`);
  }

  const state = {
    root: realRoot,
    policy: policy || {},
  };

  /**
   * Resolve a caller-supplied path (absolute or relative-to-root) into an
   * absolute path guaranteed to live inside the sandbox root. Throws if the
   * resulting path would escape the sandbox.
   *
   * Note: for paths that do not yet exist (e.g. new files being written) we
   * cannot call realpath on the target itself, so we realpath the nearest
   * existing ancestor and then reason about the remainder lexically.
   */
  function resolvePath(p) {
    if (typeof p !== "string" || p.length === 0) {
      throw new Error("sandbox: path must be a non-empty string");
    }
    const abs = isAbsolute(p) ? p : resolve(state.root, p);

    // Try to realpath the target; if it doesn't exist, walk up until we find
    // an existing ancestor and realpath that, then re-append the tail.
    let resolved;
    try {
      resolved = realpathSync(abs);
    } catch {
      resolved = resolveNonExistent(abs);
    }

    const rel = relative(state.root, resolved);
    if (rel === "") return resolved;
    if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
      throw new Error(`sandbox: path escapes root: ${p}`);
    }
    return resolved;
  }

  function resolveNonExistent(abs) {
    // Walk up the path until we find an ancestor that exists, realpath it,
    // then append the non-existing tail lexically.
    const parts = abs.split(sep);
    for (let i = parts.length - 1; i > 0; i--) {
      const candidate = parts.slice(0, i).join(sep) || sep;
      try {
        const real = realpathSync(candidate);
        const tail = parts.slice(i).join(sep);
        return tail ? resolve(real, tail) : real;
      } catch {
        // keep walking up
      }
    }
    // Fallback: no ancestor found (shouldn't happen for a valid path).
    return abs;
  }

  function checkPermission(toolName) {
    return state.policy[toolName] ?? Decision.ASK;
  }

  /**
   * Persistently update a tool's decision. Used when the driving session
   * approves or denies a pending call — for this session only.
   */
  function recordDecision(toolName, decision) {
    if (!Object.values(Decision).includes(decision)) {
      throw new Error(`sandbox: invalid decision: ${decision}`);
    }
    state.policy[toolName] = decision;
  }

  function getPolicy() {
    return { ...state.policy };
  }

  function getRoot() {
    return state.root;
  }

  /**
   * Re-validate a path AFTER it (or its parent) has been created. resolvePath
   * reasons about a not-yet-existing tail lexically; if a symlink is swapped
   * into one of those positions between resolve and write (a concurrent
   * agent, or a Bash command), the lexical path no longer reflects the real
   * target. Realpath the now-existing path and re-check containment, closing
   * that TOCTOU. A still-missing path is a no-op (nothing to follow yet).
   */
  function assertInside(absPath) {
    let real;
    try {
      real = realpathSync(absPath);
    } catch {
      return;
    }
    const rel = relative(state.root, real);
    if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes(".."))) {
      throw new Error(`sandbox: path escapes root after resolution: ${absPath}`);
    }
  }

  return {
    resolvePath,
    assertInside,
    checkPermission,
    recordDecision,
    getPolicy,
    getRoot,
  };
}
