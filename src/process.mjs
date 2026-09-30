import { spawn } from "node:child_process";

import { BenchError } from "./errors.mjs";

export async function runProcess(command, args = [], options = {}) {
  const {
    cwd,
    env = process.env,
    input,
    timeoutMs = 60_000,
    idleTimeoutMs,
    maxOutputBytes = 4 * 1024 * 1024,
    allowFailure = false,
    onStdout,
    onStderr,
  } = options;

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let overflow = false;
    let timedOut = false;
    let timeoutKind;
    let idleTimer;

    const stopForTimeout = (kind) => {
      timedOut = true;
      timeoutKind = kind;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    };
    const resetIdleTimer = () => {
      if (idleTimeoutMs === undefined) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stopForTimeout("idle"), idleTimeoutMs);
    };

    const append = (current, chunk, callback) => {
      resetIdleTimer();
      callback?.(chunk.toString("utf8"));
      if (current.length + chunk.length > maxOutputBytes) {
        overflow = true;
        return current;
      }
      return Buffer.concat([current, chunk]);
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk, onStdout); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk, onStderr); });
    child.on("error", (error) => reject(new BenchError("process_spawn_failed", `${command}: ${error.message}`)));

    const timer = timeoutMs === null ? undefined : setTimeout(() => stopForTimeout("total"), timeoutMs);
    resetIdleTimer();

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      clearTimeout(idleTimer);
      const result = {
        command,
        exitCode,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
        timeoutKind,
        overflow,
      };
      if (timedOut) {
        const message = timeoutKind === "idle"
          ? `${command} was inactive for ${idleTimeoutMs}ms`
          : `${command} exceeded ${timeoutMs}ms`;
        return reject(new BenchError("process_timeout", message, result));
      }
      if (overflow) return reject(new BenchError("process_output_limit", `${command} exceeded its output limit`, result));
      if (!allowFailure && exitCode !== 0) {
        return reject(new BenchError("process_failed", `${command} exited with ${exitCode}`, result));
      }
      resolve(result);
    });

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}
