// bash — execute a shell command inside the sandbox cwd with timeout

import { spawn } from "node:child_process";
import { setTimeout as promiseSetTimeout } from "node:timers/promises";

const MAX_BYTES = 1 * 1024 * 1024; // 1 MiB cap on output

export default {
  name: "Bash",
  description:
    "Execute a shell command inside the agent's sandbox cwd. Returns stdout, stderr, and exit code. Default timeout 30000ms.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute.",
      },
      timeout_ms: {
        type: "integer",
        description: "Optional timeout in milliseconds. Default 30000.",
        minimum: 1,
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const { sandbox } = ctx;
    const cwd = sandbox.getRoot();
    const timeout = args.timeout_ms ?? 30000;

    let proc, stdoutBytes = 0, stderrBytes = 0;
    // Throwing inside a stream 'data' listener does not propagate into
    // the async try/catch around this function — the listener is invoked
    // by Node's event loop outside that stack, so the throw becomes an
    // uncaughtException and crashes the server. Instead, record the
    // oversize condition, SIGKILL the child, and let the race resolve
    // via the exit event; we then surface the error after the await.
    let oversizeError = null;
    try {
      proc = spawn("/bin/sh", ["-c", args.command], { cwd, timeout: 0 });

      const stdout = [];
      const stderr = [];

      proc.stdout.on("data", (chunk) => {
        if (oversizeError) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_BYTES) {
          oversizeError = `stdout exceeded ${MAX_BYTES} bytes`;
          proc.kill("SIGKILL");
          return;
        }
        stdout.push(chunk);
      });

      proc.stderr.on("data", (chunk) => {
        if (oversizeError) return;
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_BYTES) {
          oversizeError = `stderr exceeded ${MAX_BYTES} bytes`;
          proc.kill("SIGKILL");
          return;
        }
        stderr.push(chunk);
      });

      const timeoutHandle = promiseSetTimeout(timeout);
      const { exitCode, signal } = await Promise.race([
        new Promise((resolve) =>
          proc.on("exit", (code, sig) => resolve({ exitCode: code, signal: sig })),
        ),
        timeoutHandle.then(() => ({ exitCode: null, signal: "timeout" })),
      ]);

      if (signal === "timeout") {
        proc.kill("SIGKILL");
        return { content: `Error: command timed out after ${timeout}ms` };
      }

      if (oversizeError) {
        return { content: `Error: ${oversizeError}` };
      }

      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exit_code: exitCode,
      };

      const isError = exitCode !== 0 && exitCode !== null;
      return { content: JSON.stringify(result), isError };
    } catch (err) {
      return { content: `Error: ${err.message}` };
    }
  },
};