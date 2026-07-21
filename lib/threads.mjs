// Thread lifecycle, per-project. ADR 0001 moved thread state into
// <cwd>/.claude/agnz/threads/, so each thread's persistence is routed
// through the workspace store for its own cwd. A lightweight index in
// the user dir resolves thread ids back to their cwds for tool calls
// that only carry an id (agent_send, agent_status, ...).
//
// Status values:
//   idle           — waiting for the next user message
//   running        — the agent loop is currently working
//   awaiting_input — paused, needs caller input. meta.pending tells what
//                    kind: "approval" (decision needed) or "question"
//                    (free-text answer expected by ask_user)
//   stopped        — explicitly closed by the caller
//   error          — crashed; see meta.error

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createWorkspaceStore, SKIP_MUTATION } from "./workspace-store.mjs";
import { registerThread, lookupThreadCwd, forgetThread, listIndex } from "./thread-index.mjs";

// Is a pid still a live OS process? Signal 0 probes without delivering anything:
// EPERM = exists but unsignalable (treat as alive), ESRCH = gone. Kept in sync
// with bin/agnz.mjs's isAlive so the admission claim and recoverIfStale agree
// on what "a live runner" means.
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

export const ThreadStatus = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  AWAITING_INPUT: "awaiting_input",
  STOPPED: "stopped",
  ERROR: "error",
});

export function createThreadManager() {
  // Cache workspace stores by cwd so we don't re-construct them on
  // every call. Stores are lightweight but the cache is free.
  const storeCache = new Map();
  function storeFor(cwd) {
    const abs = resolve(cwd);
    let s = storeCache.get(abs);
    if (!s) {
      s = createWorkspaceStore(abs);
      storeCache.set(abs, s);
    }
    return s;
  }

  /**
   * Given a thread id, resolve the store it belongs to via the index.
   * Returns null if the id is unknown.
   */
  async function storeForThreadId(threadId) {
    const cwd = await lookupThreadCwd(threadId);
    if (!cwd) return null;
    return storeFor(cwd);
  }

  /**
   * Create a new thread rooted at the given cwd. The cwd is recorded
   * in the cross-workspace index so later tool calls can resolve the
   * thread id back to its store.
   */
  // profile and policy are intentionally NOT stored in meta — they are
  // re-derived at runtime from agentDef. cwd is not stored either; it is
  // injected from the authoritative thread index when loading a thread.
  async function createThread({ cwd, agentDef, name, description }) {
    if (!cwd) throw new Error("threads: cwd is required");
    const id = randomUUID();
    const meta = {
      id,
      agentDef: agentDef || null,
      name: name || null,
      description: description || null,
      sessionCommands: { sessionAllow: [], sessionDeny: [] }, // session-scoped approvals
      knownFiles: [], // ADR 0013: files Read/Written/Edited this thread (harness knowledge state)
      card: null, // resume-card: loop-stamped { task, turns, tokens, ctxTokens } — mission + spend for reuse decisions
      status: ThreadStatus.IDLE,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      error: null,
      pending: null, // when status=awaiting_input: { toolCallId, kind, ... }
    };
    const store = storeFor(cwd);
    await store.writeThreadMeta(id, meta);
    await registerThread(id, cwd);
    // Ensure the workspace skeleton exists. Idempotent: existing workspaces are preserved.
    await store.ensureWorkspace();
    // Return meta with cwd injected for in-memory use (cwd is not stored in
    // the file — the thread index is the authoritative source).
    return { ...meta, cwd: resolve(cwd) };
  }

  async function getThread(id) {
    // cwd comes from the authoritative thread index, not the stored meta.
    const cwd = await lookupThreadCwd(id);
    if (!cwd) return null;
    const store = storeFor(cwd);
    const meta = await store.readThreadMeta(id);
    if (!meta) return null;
    return { ...meta, cwd };
  }

  // patch may be a plain object (merged as-is) or a function (current) =>
  // patch. The function form lets callers derive the patch from the latest
  // committed meta INSIDE the serialised mutate — required whenever the new
  // value depends on the old one (e.g. appending to sessionCommands), which
  // a precomputed object patch would race on.
  async function updateThread(id, patch) {
    const store = await storeForThreadId(id);
    if (!store) throw new Error(`threads: no such thread: ${id}`);
    return store.mutateThreadMeta(id, (current) =>
      typeof patch === "function" ? patch(current) : patch,
    );
  }

  async function setStatus(id, status, extras = {}) {
    return updateThread(id, { status, ...extras });
  }

  /**
   * Admission control for the detached runner (fixes the two-runner race). The
   * CLI's check-then-spawn has a TOCTOU window: a second spawn can pass the
   * "not running" check before the first runner flips the thread to running,
   * yielding two runners appending to one transcript. This is the authoritative
   * gate, run INSIDE the cross-process meta lock so the decision is atomic.
   *
   * Refuses (returns false, writes nothing) only when the thread is already
   * `running` AND owned by a DIFFERENT, still-alive runner pid. Otherwise it
   * claims the thread — records `runnerPid` and flips to `running`, clearing the
   * stale `pending`/`error` the same way loop.setStatus(RUNNING) does — and
   * returns true. A dead owner pid (stale runnerPid left by a crash) is
   * claimable, matching recoverIfStale's liveness semantics.
   *
   * `isAlive` is injectable so a test can pass a deterministic liveness probe.
   */
  async function claimThread(id, pid, { isAlive = pidAlive } = {}) {
    let claimed = false;
    await updateThread(id, (current) => {
      const owner = current.runnerPid;
      if (current.status === ThreadStatus.RUNNING && owner && owner !== pid && isAlive(owner)) {
        return SKIP_MUTATION; // another live runner owns it — touch nothing
      }
      claimed = true;
      return { status: ThreadStatus.RUNNING, runnerPid: pid, pending: null, error: null };
    });
    return claimed;
  }

  async function stopThread(id) {
    const result = await setStatus(id, ThreadStatus.STOPPED);
    // Intentionally do NOT forget() from the index on stop — stopped
    // threads can still be inspected via agent_status. forget() runs
    // only when the user explicitly deletes a thread (future op).
    return result;
  }

  /**
   * Reconcile a single workspace's on-disk threads with the user-wide index
   * (self-healing). The threads/ dir is the source of truth: any meta present
   * on disk but missing from the index is re-registered. This repairs "ghost"
   * threads — meta on disk, no index entry — that an over-aggressive index
   * prune or an index/disk desync would otherwise hide from list and send.
   * Returns this workspace's threads with the authoritative cwd injected,
   * newest first.
   */
  async function reconcileWorkspace(cwd) {
    if (!cwd) return [];
    const abs = resolve(cwd);
    const store = storeFor(abs);
    const metas = await store.listThreads(); // dir scan = source of truth
    const index = await listIndex();
    for (const meta of metas) {
      if (!(meta.id in index)) await registerThread(meta.id, abs);
    }
    return metas.map((m) => ({ ...m, cwd: abs }));
  }

  /**
   * List threads across every workspace the index knows about. Each workspace
   * is reconciled (its threads/ dir is the source of truth and any ghost is
   * re-registered), so a thread with a meta on disk appears even if its index
   * entry was lost. Stale index entries (workspace dir gone) are skipped, not
   * pruned — prune is a separate housekeeping op. A workspace wholly absent
   * from the index cannot be discovered here; a caller that knows a specific
   * cwd should reconcile it directly (see reconcileWorkspace / the list verb).
   */
  async function listThreads() {
    const index = await listIndex();
    const cwds = new Set(Object.values(index).map((e) => e.cwd));
    const results = [];
    const seen = new Set();
    for (const cwd of cwds) {
      let metas;
      try {
        metas = await reconcileWorkspace(cwd);
      } catch {
        continue; // workspace dir gone or unreadable — skip
      }
      for (const t of metas) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        results.push(t);
      }
    }
    results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return results;
  }

  async function appendMessage(id, message) {
    const store = await storeForThreadId(id);
    if (!store) throw new Error(`threads: no such thread: ${id}`);
    await store.appendThreadMessage(id, message);
    await updateThread(id, {}); // bump updatedAt
  }

  async function readMessages(id) {
    const store = await storeForThreadId(id);
    if (!store) return [];
    return store.readThreadMessages(id);
  }

  return {
    createThread,
    getThread,
    updateThread,
    setStatus,
    claimThread,
    stopThread,
    listThreads,
    reconcileWorkspace,
    appendMessage,
    readMessages,
    // Expose for housekeeping / explicit deletion flows:
    forgetThread,
  };
}
