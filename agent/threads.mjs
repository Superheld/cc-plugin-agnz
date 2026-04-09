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
import { createWorkspaceStore } from "./workspace-store.mjs";
import { registerThread, lookupThreadCwd, forgetThread, listIndex } from "./thread-index.mjs";

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
  async function createThread({ cwd, profile, policy, systemPrompt, agentDef }) {
    if (!cwd) throw new Error("threads: cwd is required");
    const id = randomUUID();
    const meta = {
      id,
      cwd: resolve(cwd),
      profile,
      policy: policy || null,
      systemPrompt: systemPrompt || null,
      agentDef: agentDef || null,
      status: ThreadStatus.IDLE,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      error: null,
      pending: null, // when status=awaiting_input: { toolCallId, kind, ... }
    };
    const store = storeFor(cwd);
    await store.writeThreadMeta(id, meta);
    await registerThread(id, cwd);
    // Ensure the workspace skeleton exists and register this thread
    // as a member. Idempotent: existing workspaces are preserved.
    const ws = await store.ensureWorkspace();
    const members = Array.isArray(ws.members) ? ws.members : [];
    if (!members.includes(id)) {
      await store.updateWorkspace({ members: [...members, id] });
    }
    return meta;
  }

  async function getThread(id) {
    const store = await storeForThreadId(id);
    if (!store) return null;
    return store.readThreadMeta(id);
  }

  async function updateThread(id, patch) {
    const store = await storeForThreadId(id);
    if (!store) throw new Error(`threads: no such thread: ${id}`);
    const current = await store.readThreadMeta(id);
    if (!current) throw new Error(`threads: no such thread: ${id}`);
    const next = { ...current, ...patch, updatedAt: Date.now() };
    await store.writeThreadMeta(id, next);
    return next;
  }

  async function setStatus(id, status, extras = {}) {
    return updateThread(id, { status, ...extras });
  }

  async function stopThread(id) {
    const result = await setStatus(id, ThreadStatus.STOPPED);
    // Intentionally do NOT forget() from the index on stop — stopped
    // threads can still be inspected via agent_status. forget() runs
    // only when the user explicitly deletes a thread (future op).
    return result;
  }

  /**
   * List threads across all known workspaces. Walks the index and
   * reads each workspace store. Stale index entries (workspace dir
   * gone) are skipped, not pruned — prune is a housekeeping op.
   */
  async function listThreads() {
    const index = await listIndex();
    const results = [];
    const stores = new Map();
    for (const [id, entry] of Object.entries(index)) {
      let store = stores.get(entry.cwd);
      if (!store) {
        store = storeFor(entry.cwd);
        stores.set(entry.cwd, store);
      }
      try {
        const meta = await store.readThreadMeta(id);
        if (meta) results.push(meta);
      } catch {
        // Workspace dir gone or unreadable — silently skip.
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
    stopThread,
    listThreads,
    appendMessage,
    readMessages,
    // Expose for housekeeping / explicit deletion flows:
    forgetThread,
  };
}
