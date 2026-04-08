// In-memory tracker for in-flight runThread() promises. Purpose: let
// agent_send return immediately (detach mode) while runThread continues
// in the background, and let agent_wait pick up the resulting outcome.
//
// Node is single-threaded but its event loop is cooperative — while a
// sub-agent is awaiting a fetch() to LM Studio, the MCP server can serve
// other requests. So we get real concurrency for free, no workers, no
// child processes.
//
// Lifetime:
//   - kick(threadId, fn) replaces any existing entry, runs fn(), stores
//     the resulting promise (with a .catch to swallow unhandled rejection)
//   - wait(threadId, timeoutMs?) awaits that promise, with optional
//     timeout. Multiple concurrent waits on the same thread are fine
//     since promises can be awaited any number of times.
//   - The cached promise is kept until the next kick(). It always
//     remains awaitable — settled promises just resolve immediately on
//     subsequent waits, returning the cached outcome.

const inflight = new Map(); // threadId → Promise<outcome>

/**
 * Kick off a background run. fn() must return a Promise<outcome>.
 * Returns the promise (in case the caller wants to await it directly,
 * e.g. for the synchronous agent_send path).
 */
export function kick(threadId, fn) {
  const p = Promise.resolve().then(() => fn());
  // Prevent unhandled rejection: callers may never await this if they
  // detached and the request comes back as an error. The error stays
  // attached to the promise so a later wait() still surfaces it.
  p.catch(() => {});
  inflight.set(threadId, p);
  return p;
}

/**
 * Wait for the latest run on this thread to settle. If no run was
 * tracked, returns null (caller should fall back to reading thread meta).
 *
 * If timeoutMs is given and the promise doesn't settle in time, returns
 * { timedOut: true }. The underlying run keeps going.
 */
export async function wait(threadId, timeoutMs) {
  const p = inflight.get(threadId);
  if (!p) return null;

  if (timeoutMs == null || timeoutMs <= 0) {
    return { outcome: await p };
  }

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  try {
    const winner = await Promise.race([p.then((outcome) => ({ outcome })), timeout]);
    return winner;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drop the tracker entry for a thread. Used by agent_stop.
 */
export function forget(threadId) {
  inflight.delete(threadId);
}

/**
 * Quick check: is something currently in flight for this thread?
 * Note: a settled promise still counts as "tracked" — the caller
 * should compare against thread.status to know if work is actually
 * still happening.
 */
export function isTracked(threadId) {
  return inflight.has(threadId);
}
