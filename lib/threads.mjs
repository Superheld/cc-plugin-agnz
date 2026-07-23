// Thread lifecycle, per-project. ADR 0001 moved thread state into
// <cwd>/.claude/agnz/threads/, so each thread's persistence is routed
// through the workspace store for its own cwd. Resolution of a bare
// thread id to its cwd is in-process only (ADR 0017): createThread and
// reconcileWorkspace populate a Map, and callers in a fresh process
// (the runner, the CLI) seed it by passing their cwd. The former
// user-wide thread-index.json — a cache with cache-invalidation bugs —
// is gone.
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

  // In-process id → cwd map. Populated by createThread and by every
  // reconcileWorkspace/getThread-with-hint; a fresh process (runner, CLI)
  // seeds it with its own cwd. Never persisted.
  const cwdById = new Map();

  function storeForThreadId(threadId) {
    const cwd = cwdById.get(threadId);
    return cwd ? storeFor(cwd) : null;
  }

  /**
   * Create a new thread rooted at the given cwd.
   */
  // profile and policy are intentionally NOT stored in meta — they are
  // re-derived at runtime from agentDef. cwd is not stored either; it is
  // injected in-memory from where the meta file was found.
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
      fileStamps: {}, // context-diet: per-known-file { mtimeMs, size, full } from the last Read/Write/Edit
      visitedDirs: [], // ADR 0012: subdirs whose CLAUDE.md was already queued/injected (persisted so a resume can't re-inject)
      pendingDirMds: [], // ADR 0012: subdirs queued for one-time CLAUDE.md injection at the next turn boundary
      card: null, // resume-card: loop-stamped { task, turns, tokens, ctxTokens } — mission + spend for reuse decisions
      status: ThreadStatus.IDLE,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      error: null,
      pending: null, // when status=awaiting_input: { toolCallId, kind, ... }
    };
    const store = storeFor(cwd);
    await store.writeThreadMeta(id, meta);
    cwdById.set(id, resolve(cwd));
    // Ensure the workspace skeleton exists. Idempotent: existing workspaces are preserved.
    await store.ensureWorkspace();
    return { ...meta, cwd: resolve(cwd) };
  }

  /**
   * Load a thread by id. `cwdHint` seeds resolution in a fresh process
   * (the runner passes its payload cwd); without it, only ids already
   * seen by this manager instance resolve.
   */
  async function getThread(id, cwdHint = null) {
    let cwd = cwdById.get(id);
    if (!cwd && cwdHint) {
      const candidate = resolve(cwdHint);
      const meta = await storeFor(candidate).readThreadMeta(id);
      if (meta) {
        cwdById.set(id, candidate);
        cwd = candidate;
      }
    }
    if (!cwd) return null;
    const meta = await storeFor(cwd).readThreadMeta(id);
    if (!meta) return null;
    return { ...meta, cwd };
  }

  // patch may be a plain object (merged as-is) or a function (current) =>
  // patch. The function form lets callers derive the patch from the latest
  // committed meta INSIDE the serialised mutate — required whenever the new
  // value depends on the old one (e.g. appending to sessionCommands), which
  // a precomputed object patch would race on.
  async function updateThread(id, patch) {
    const store = storeForThreadId(id);
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
      // pendingRun is the CLI's spawn-intent marker (stamped before the spawn
      // so wait/list/show don't misread the pre-claim "idle" as "finished").
      // The claim is the moment the intent became reality — clear it here, in
      // the same atomic write.
      return { status: ThreadStatus.RUNNING, runnerPid: pid, pending: null, error: null, pendingRun: null };
    });
    return claimed;
  }

  async function stopThread(id) {
    const result = await setStatus(id, ThreadStatus.STOPPED);
    // Intentionally do NOT forget() from the index on stop — stopped
    // threads can still be inspected. forget() runs only on removeThread.
    return result;
  }

  /**
   * Permanently delete a thread: every threads/<id>.* file (meta,
   * transcript, trace — and any companion added later) plus its index
   * entry. The workspace message log is untouched; history that mentions
   * the thread stays. Irreversible: `stop` is the archive path, this is
   * the disposal path. Liveness policy (refusing to delete a running
   * thread) is the caller's job — the CLI checks before calling.
   */
  async function removeThread(id) {
    const thread = await getThread(id);
    if (!thread) throw new Error(`threads: no such thread: ${id}`);
    const store = storeFor(thread.cwd);
    const files = await store.deleteThreadFiles(id);
    cwdById.delete(id);
    return { id, files };
  }

  /**
   * Scan a workspace's threads/ dir — the source of truth — and seed the
   * in-process id → cwd map for every thread found, so subsequent by-id
   * calls (updateThread, appendMessage, …) resolve. Returns this
   * workspace's threads with cwd injected, newest first. (Pre-ADR-0017
   * this also repaired the user-wide index; the index is gone, so this
   * is now a plain scan-and-seed.)
   */
  async function reconcileWorkspace(cwd) {
    if (!cwd) return [];
    const abs = resolve(cwd);
    const store = storeFor(abs);
    const metas = await store.listThreads(); // dir scan = source of truth
    for (const meta of metas) cwdById.set(meta.id, abs);
    return metas.map((m) => ({ ...m, cwd: abs }));
  }

  /**
   * List a workspace's threads (alias of reconcileWorkspace — kept as the
   * intention-revealing name for read-only callers). Cross-workspace
   * listing died with the user-wide index (ADR 0017): threads are always
   * addressed from their project's cwd.
   */
  async function listThreads(cwd) {
    return reconcileWorkspace(cwd);
  }

  async function appendMessage(id, message) {
    const store = storeForThreadId(id);
    if (!store) throw new Error(`threads: no such thread: ${id}`);
    await store.appendThreadMessage(id, message);
    await updateThread(id, {}); // bump updatedAt
  }

  async function readMessages(id) {
    const store = storeForThreadId(id);
    if (!store) return [];
    return store.readThreadMessages(id);
  }

  // ---- system prompt snapshot (ADR 0017) ----

  async function writeSystemPrompt(id, text) {
    const store = storeForThreadId(id);
    if (!store) throw new Error(`threads: no such thread: ${id}`);
    await store.writeSystemPrompt(id, text);
  }

  async function readSystemPrompt(id) {
    const store = storeForThreadId(id);
    if (!store) return null;
    return store.readSystemPrompt(id);
  }

  return {
    createThread,
    getThread,
    updateThread,
    setStatus,
    claimThread,
    stopThread,
    removeThread,
    listThreads,
    reconcileWorkspace,
    appendMessage,
    readMessages,
    writeSystemPrompt,
    readSystemPrompt,
  };
}
