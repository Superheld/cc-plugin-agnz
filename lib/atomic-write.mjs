// Atomic file write via temp-file + rename.
//
// rename(2) is atomic on POSIX within a single filesystem: a concurrent
// reader sees either the old file or the new one, never a half-written
// one, and a crash mid-write leaves the original intact (only an orphan
// .tmp). The temp name carries pid + a process-local counter so two
// writers — across processes or concurrently within one — never pick the
// same temp path. The temp lives in the target's own directory, so the
// rename stays on one filesystem (no EXDEV).

import { writeFile, rename } from "node:fs/promises";

let counter = 0;

export async function atomicWriteFile(file, data, encoding = "utf8") {
  const tmp = `${file}.tmp-${process.pid}-${counter++}`;
  await writeFile(tmp, data, encoding);
  await rename(tmp, file);
}
