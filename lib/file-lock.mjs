// In-process per-key mutex.
//
// Serialises whole read-modify-write cycles against the same key (e.g. an
// absolute file path) so two concurrent callers cannot both read the same
// committed state and then clobber each other's write — the classic
// lost-update. Each key holds a promise chain; a new call waits for the
// previous one to settle before running.
//
// SCOPE: this guards only callers *within one Node process*. Today agnz
// runs as a single MCP server process, so that is sufficient. Once the CLI
// spawns multiple runner processes (redesign tasks #2/#3) the same files
// will be touched across processes and this must be backed by an OS-level
// file lock. Call sites that need that are marked CROSS-PROCESS.
//
// The lock entry is removed once the key goes idle, so the map does not
// grow without bound.

const locks = new Map();

export function withFileLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  // Run fn whether or not the previous holder rejected — one caller's
  // failure must not wedge the queue for the next.
  const result = prev.then(fn, fn);
  const guard = result.then(
    () => {},
    () => {},
  );
  locks.set(key, guard);
  guard.then(() => {
    if (locks.get(key) === guard) locks.delete(key);
  });
  return result;
}
