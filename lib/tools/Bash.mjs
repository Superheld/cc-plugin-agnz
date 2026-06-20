// bash — execute a shell command inside the sandbox cwd with a timeout.

import { spawn } from "node:child_process";
import { setTimeout as promiseSetTimeout } from "node:timers/promises";

const MAX_BYTES = 1 * 1024 * 1024; // 1 MiB cap on output

export default {
  name: "Bash",
  description: "Run a shell command. Returns stdout, stderr, exit_code as JSON.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Command to run." },
      timeout_ms: { type: "integer", description: "Timeout in ms. Default 30000.", minimum: 1 },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const { sandbox, signal } = ctx;
    // NOTE: Bash is NOT path-confined. It runs with cwd = sandbox root, but a
    // command can still reach outside it (../../etc, absolute paths, ln -s).
    // The only gate is the tool-level approval policy (Bash is `ask` for most
    // agents — see ADR 0003); path-string confinement cannot constrain a shell.
    const cwd = sandbox.getRoot();
    const timeout = args.timeout_ms ?? 30000;

    let proc;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let oversizeError = null;

    // detached:true puts the child in its own process group so we can kill the
    // whole group — the shell AND any grandchildren it spawned — not just the
    // shell. Otherwise long-running descendants leak on timeout/abort/oversize.
    const killGroup = () => {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };

    try {
      proc = spawn("/bin/sh", ["-c", args.command], { cwd, detached: true });

      const stdout = [];
      const stderr = [];
      proc.stdout.on("data", (chunk) => {
        if (oversizeError) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_BYTES) {
          oversizeError = `stdout exceeded ${MAX_BYTES} bytes`;
          killGroup();
          return;
        }
        stdout.push(chunk);
      });
      proc.stderr.on("data", (chunk) => {
        if (oversizeError) return;
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_BYTES) {
          oversizeError = `stderr exceeded ${MAX_BYTES} bytes`;
          killGroup();
          return;
        }
        stderr.push(chunk);
      });

      // Cancellable timeout so the timer doesn't linger after a normal exit.
      const timerAbort = new AbortController();
      const timeoutP = promiseSetTimeout(timeout, "timeout", { signal: timerAbort.signal })
        .then((v) => ({ exitCode: null, signal: v }))
        .catch(() => new Promise(() => {})); // cancelled timer never wins the race
      const exitP = new Promise((resolve) =>
        proc.on("exit", (code, sig) => resolve({ exitCode: code, signal: sig })),
      );
      const abortP = new Promise((resolve) => {
        if (!signal) return;
        if (signal.aborted) return resolve({ exitCode: null, signal: "aborted" });
        signal.addEventListener("abort", () => resolve({ exitCode: null, signal: "aborted" }), {
          once: true,
        });
      });

      const { exitCode, signal: sig } = await Promise.race([exitP, timeoutP, abortP]);
      timerAbort.abort(); // stop the pending timer regardless of who won

      if (sig === "aborted") {
        killGroup();
        return { content: "Error: command aborted", isError: true };
      }
      if (sig === "timeout") {
        killGroup();
        return { content: `Error: command timed out after ${timeout}ms`, isError: true };
      }
      if (oversizeError) {
        return { content: `Error: ${oversizeError}`, isError: true };
      }

      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exit_code: exitCode,
      };
      // exitCode null means killed by a signal rather than a clean exit.
      const isError = exitCode !== 0;
      return { content: JSON.stringify(result), isError };
    } catch (err) {
      return { content: `Error: ${err.message}`, isError: true };
    }
  },
};
