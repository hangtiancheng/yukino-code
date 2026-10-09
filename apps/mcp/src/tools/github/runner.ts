import { spawn } from "node:child_process";

export interface GhResult {
  stdout: Buffer;
  stderr: string;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  cancelled: boolean;
}

/** Run gh directly, preserving argument boundaries and stdin bytes. */
export function runGh(
  args: string[],
  options: {
    cwd?: string;
    stdin?: string;
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
  },
): Promise<GhResult> {
  return new Promise((resolve, reject) => {
    options.signal.throwIfAborted();
    const processGroup = process.platform !== "win32";
    const child = spawn("gh", args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
      detached: processGroup,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let cancelled = false;

    function stop(): void {
      // Aliases and extensions may spawn children that inherit our pipes.
      // Terminate the group so a timeout also releases those handles.
      if (processGroup && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // A process that has already exited needs no further cleanup.
        }
      }
      child.kill("SIGKILL");
    }
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    function cleanup(): void {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
    }

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on("error", () => undefined);
    child.on("close", (exitCode, signal) => {
      cleanup();
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exit_code: exitCode,
        signal,
        timed_out: timedOut,
        cancelled,
      });
    });
    child.stdin.end(options.stdin ?? "");
  });
}
