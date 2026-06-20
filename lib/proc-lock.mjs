// Cross-process advisory lock via atomic mkdir.
//
// mkdir is atomic across processes on POSIX, so a lock *directory* is a simple
// mutex the OS arbitrates — exactly what we need now that the CLI runs many
// short-lived processes that touch the same state files (messages.jsonl, a
// thread's meta.json, the thread index). It serialises read-modify-write
// across processes; the in-process promise-chain mutexes still handle the
// common single-process case efficiently. A crashed holder is stolen after a
// timeout so the lock can never wedge permanently.

import { mkdir, rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

export async function withProcLock(lockPath, fn, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(lockPath); // atomic; throws EEXIST if another holder has it
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (Date.now() > deadline) {
        // Assume the holder crashed; steal the lock and retry.
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      await sleep(15);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
