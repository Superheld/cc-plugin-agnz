// Thread lifecycle on top of the memory store. A thread is a conversation
// with an agent instance scoped to a cwd, a profile, and a permission
// policy. Threads are persistent: the driving Claude session can come
// back to a thread by id, read its status, resume the conversation.
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

export const ThreadStatus = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  AWAITING_INPUT: "awaiting_input",
  STOPPED: "stopped",
  ERROR: "error",
});

export function createThreadManager({ memory }) {
  if (!memory) throw new Error("threads: memory store is required");

  /**
   * Create a new thread and persist its metadata. Returns the meta record.
   * The caller is expected to supply a valid, existing cwd and profile name.
   */
  async function createThread({ cwd, profile, policy, systemPrompt }) {
    const id = randomUUID();
    const meta = {
      id,
      cwd: resolve(cwd),
      profile,
      policy: policy || null,
      systemPrompt: systemPrompt || null,
      status: ThreadStatus.IDLE,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      error: null,
      pending: null, // when status=awaiting_input: { toolCallId, kind, ... }
    };
    await memory.writeThreadMeta(id, meta);
    return meta;
  }

  async function getThread(id) {
    return memory.readThreadMeta(id);
  }

  async function updateThread(id, patch) {
    const current = await memory.readThreadMeta(id);
    if (!current) throw new Error(`threads: no such thread: ${id}`);
    const next = { ...current, ...patch, updatedAt: Date.now() };
    await memory.writeThreadMeta(id, next);
    return next;
  }

  async function setStatus(id, status, extras = {}) {
    return updateThread(id, { status, ...extras });
  }

  async function stopThread(id) {
    return setStatus(id, ThreadStatus.STOPPED);
  }

  async function listThreads() {
    return memory.listThreads();
  }

  /**
   * Append a message to the thread transcript. Messages are whatever the
   * agent loop wants to persist — user turns, assistant turns, tool calls,
   * tool results. Keeping them in one stream simplifies replay.
   */
  async function appendMessage(id, message) {
    await memory.appendThreadMessage(id, message);
    await updateThread(id, {}); // bump updatedAt
  }

  async function readMessages(id) {
    return memory.readThreadMessages(id);
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
  };
}
