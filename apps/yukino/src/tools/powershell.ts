/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { execFile, spawn } from "node:child_process";
import { statSync } from "node:fs";

import {
  POWERSHELL_BACKGROUND_DESCRIPTION,
  POWERSHELL_DESCRIPTION,
} from "./descriptions.js";
import {
  BACKGROUND_MAX_OUTPUT_BYTES,
  SIZE_WATCHDOG_INTERVAL_MS,
  backgroundMessage,
  backgroundTaskName,
  buildBackgroundBody,
  createShellOutputFile,
  discardFd,
  formatFinalResult,
  isAutobackgroundingAllowed,
  readOutputFile,
  unlinkQuiet,
  type BackgroundReason,
  type CommandHandle,
  type ShellExit,
} from "./shell-background.js";
import { MAX_SHELL_OUTPUT_BYTES } from "./shell-output.js";
import {
  type Tool,
  type ToolCategory,
  type ToolContext,
  type ToolResult,
  type ToolSchema,
} from "./types.js";

import { TaskFailure, type TaskManager } from "@/subagent/task-manager.js";
import {
  asErrorString,
  asRecord,
  boolArg,
  intArg,
  strArg,
} from "@/utils/index.js";

const MAX_TIMEOUT = 600;
// Grace period between the graceful kill and the forced-kill escalation.
const KILL_GRACE_MS = 3000;
// Start-Sleep (and its built-in `sleep` alias) is killed on timeout instead of
// auto-backgrounded: backgrounding one would just hold a task slot until
// session end. Mirrors Bash's bare-sleep blocklist.
const DISALLOWED_AUTO_BACKGROUND_COMMANDS = new Set(["start-sleep", "sleep"]);

export class PowerShellTool implements Tool {
  // Use a hardcoded string instead of PowerShellTool.name.replace("Tool", "")
  // because class names are not stable after minification — bundlers like
  // Terser/esbuild may rename or mangle them, producing incorrect tool names at runtime.
  name = "PowerShell";

  description: string = POWERSHELL_DESCRIPTION;
  category: ToolCategory = "command";

  /**
   * Background task registry, injected by the host — same contract as
   * BashTool.taskManager (schema gating, timeout auto-background, Ctrl+B).
   * Calls running inside a subagent loop carry that loop's own manager in
   * ctx.taskManager, which takes precedence.
   */
  taskManager: TaskManager | null = null;

  /** Running foreground executions eligible for manual backgrounding (Ctrl+B). */
  private foreground = new Map<string, { background: () => boolean }>();
  private nextForegroundId = 1;

  /** Instance-level background gate; see BashTool.backgroundEnabled. */
  backgroundEnabled(): boolean {
    return (
      this.taskManager !== null &&
      process.env.YUKINO_DISABLE_BACKGROUND_TASKS !== "1"
    );
  }

  /** True while at least one foreground PowerShell command runs. */
  hasForegroundTasks(): boolean {
    return this.foreground.size > 0;
  }

  /** Move every running foreground command to the background (Ctrl+B). */
  backgroundForegroundTasks(): number {
    let count = 0;
    for (const entry of [...this.foreground.values()]) {
      if (entry.background()) {
        count++;
      }
    }
    return count;
  }

  schema(): ToolSchema {
    const properties: Record<string, object> = {
      command: {
        type: "string",
        description: "PowerShell command to execute",
      },
      timeout: {
        type: "integer",
        description: "Timeout in seconds (max 600)",
        default: 120,
      },
    };
    let description = this.description;
    if (this.backgroundEnabled()) {
      properties.run_in_background = {
        type: "boolean",
        description:
          "Run the command in the background. Returns a task ID immediately; the result arrives later as a task notification.",
        default: false,
      };
      description = `${this.description}\n${POWERSHELL_BACKGROUND_DESCRIPTION}`;
    }
    return {
      name: this.name,
      description,
      input_schema: {
        type: "object" as const,
        properties,
        required: ["command"],
      },
    };
  }

  async execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const command = strArg(args, "command");
    if (!command) {
      return {
        output: "Error: command is required",
        isError: true,
      };
    }

    let timeout = intArg(args, "timeout", 120);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      return {
        output: "Error: timeout must be a finite number greater than 0 seconds",
        isError: true,
      };
    }
    if (timeout > MAX_TIMEOUT) {
      timeout = MAX_TIMEOUT;
    }

    // `ctx.taskManager === null` explicitly disables backgrounding for this
    // call (in-process teammate turns) and must not fall back to the instance
    // manager; only `undefined` (no loop-level decision) falls back.
    const manager =
      ctx.taskManager !== undefined ? ctx.taskManager : this.taskManager;
    const backgroundAvailable =
      manager !== null && process.env.YUKINO_DISABLE_BACKGROUND_TASKS !== "1";
    const runInBackground =
      boolArg(args, "run_in_background") && backgroundAvailable;

    // No OS-sandbox wrapping here: the seatbelt/bwrap wrappers are bash-specific
    // (`... bash -c '...'`), and Windows — this tool's primary platform — has no
    // OS sandbox support anyway.
    const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";

    let outputFile: { path: string; fd: number };
    try {
      outputFile = createShellOutputFile(ctx.workDir, ctx.sessionId ?? "");
    } catch (error) {
      return {
        output: `Error creating output file: ${asErrorString(error)}`,
        isError: true,
      };
    }

    if (ctx.abortSignal?.aborted) {
      discardFd(outputFile.fd);
      unlinkQuiet(outputFile.path);
      return {
        output: "Error: command interrupted",
        isError: true,
      };
    }

    const handle = this.startCommand(
      ctx,
      shell,
      command,
      timeout,
      outputFile,
      manager,
    );
    if (runInBackground) {
      const taskId = handle.background("explicit");
      if (taskId !== null) {
        return {
          output: backgroundMessage("explicit", taskId, timeout),
          isError: false,
        };
      }
      // The command ended before it could be backgrounded; report its actual result.
    }
    return handle.result;
  }

  /**
   * Spawn PowerShell with stdout+stderr writing directly into the output file
   * (fd mode, shared with BashTool): output never flows through JS, so
   * backgrounding is a bookkeeping switch — no re-spawn, no buffer handover.
   */
  private startCommand(
    ctx: ToolContext,
    shell: string,
    command: string,
    timeout: number,
    outputFile: { path: string; fd: number },
    manager: TaskManager | null,
  ): CommandHandle {
    // Async execution keeps the Node event loop free (see BashTool for details).
    //
    // Timeout and abort are handled manually instead of via spawn's built-in
    // timeout/signal options: those only signal the direct child, so a
    // command that spawns children or ignores the signal keeps running and
    // the callback never fires, wedging the agent loop and making Esc appear
    // dead. On POSIX `detached` puts the child in its own process group so
    // the whole tree can be killed (SIGTERM, then SIGKILL escalation); on
    // Windows the tree is killed via `taskkill /T`, forced after the grace
    // period.
    let backgroundFn: ((reason: BackgroundReason) => string | null) | undefined;
    const result = new Promise<ToolResult>((resolve) => {
      let aborted = false;
      let terminating = false;
      let settled = false;
      let backgrounded = false;
      let sizeKilled = false;
      let escalateTimer: NodeJS.Timeout | null = null;

      const shellCommand =
        process.platform === "win32"
          ? "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n" +
            command
          : command;
      const shellArgs =
        process.platform === "win32"
          ? [
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-Command",
              shellCommand,
            ]
          : ["-NoProfile", "-NonInteractive", "-Command", shellCommand];

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(shell, shellArgs, {
          cwd: ctx.workDir,
          // Only POSIX needs its own process group for kill(-pid); the Windows
          // tree kill goes through taskkill and needs no new group.
          detached: process.platform !== "win32",
          // stdout and stderr share one O_APPEND fd: each write lands on disk
          // atomically and the streams interleave chronologically.
          stdio: ["ignore", outputFile.fd, outputFile.fd],
        });
      } catch (error) {
        discardFd(outputFile.fd);
        unlinkQuiet(outputFile.path);
        resolve({
          output: `Error executing command: ${asErrorString(error)}`,
          isError: true,
        });
        return;
      }
      // The child holds a dup of the descriptor; drop our handle so the file
      // can be unlinked independently of the process lifetime.
      discardFd(outputFile.fd);

      // Resolved with the exit facts when the process ends; the background
      // task runner consumes them to build the completion notification.
      let doneResolve: ((exit: ShellExit) => void) | undefined;
      const done = new Promise<ShellExit>((resolveDone) => {
        doneResolve = resolveDone;
      });

      const alreadyExited = () =>
        child.exitCode !== null || child.signalCode !== null;

      // Kill the child's whole process tree; fall back to the direct child
      // when the group is already gone or the tree kill fails.
      const killTree = (signal: NodeJS.Signals) => {
        if (typeof child.pid !== "number") {
          return;
        }
        if (process.platform === "win32") {
          // taskkill /T terminates the whole tree; /F is the forced variant.
          const flags = ["/pid", String(child.pid), "/T"];
          if (signal === "SIGKILL") {
            flags.push("/F");
          }
          execFile("taskkill", flags, (err) => {
            if (err && !alreadyExited()) {
              try {
                child.kill(signal);
              } catch {
                /* already dead */
              }
            }
          });
          return;
        }
        try {
          process.kill(-child.pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            /* already dead */
          }
        }
      };

      const terminate = () => {
        if (terminating) {
          return;
        }
        terminating = true;
        killTree("SIGTERM");
        escalateTimer = setTimeout(() => {
          killTree("SIGKILL");
        }, KILL_GRACE_MS);
        escalateTimer.unref();
      };

      // The child writes directly to the output file with no JS in the write
      // path, so size is enforced by polling stat(): foreground keeps the
      // historical 10MB cap, backgrounded commands get the 5GB ceiling.
      const watchdog = setInterval(() => {
        let size = 0;
        try {
          size = statSync(outputFile.path).size;
        } catch {
          return;
        }
        const cap = backgrounded
          ? BACKGROUND_MAX_OUTPUT_BYTES
          : MAX_SHELL_OUTPUT_BYTES;
        if (size > cap) {
          sizeKilled = backgrounded;
          clearInterval(watchdog);
          terminate();
        }
      }, SIZE_WATCHDOG_INTERVAL_MS);
      watchdog.unref();

      const onAbort = () => {
        aborted = true;
        terminate();
      };

      const backgroundAvailableHere =
        manager !== null && process.env.YUKINO_DISABLE_BACKGROUND_TASKS !== "1";
      // The Start-Sleep blocklist gates *automatic* backgrounding only;
      // explicit run_in_background and manual Ctrl+B are always honored.
      const autoBackgroundAllowed =
        backgroundAvailableHere &&
        isAutobackgroundingAllowed(
          command,
          DISALLOWED_AUTO_BACKGROUND_COMMANDS,
        );

      let timedOut = false;
      const timeoutTimer = setTimeout(() => {
        // Auto-background on timeout when allowed; otherwise hard-kill.
        if (autoBackgroundAllowed && backgroundExecution("timeout") !== null) {
          return;
        }
        timedOut = true;
        terminate();
      }, timeout * 1000);
      timeoutTimer.unref();

      ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });
      if (ctx.abortSignal?.aborted) {
        onAbort();
      }

      const foregroundKey = `ps-${String(this.nextForegroundId++)}`;

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        clearInterval(watchdog);
        if (escalateTimer) {
          clearTimeout(escalateTimer);
        }
        ctx.abortSignal?.removeEventListener("abort", onAbort);
        this.foreground.delete(foregroundKey);
      };

      const settle = (finalResult: ToolResult) => {
        if (settled) {
          // Already resolved: backgroundExecution moved the command to the
          // background (its task runner owns the completion from here).
          return;
        }
        settled = true;
        cleanup();
        resolve(finalResult);
      };

      // Foreground completion: read the output back (capped), inline it, and
      // delete the now-redundant file.
      const settleExit = (exit: ShellExit) => {
        if (backgrounded) {
          return;
        }
        const read = readOutputFile(outputFile.path, MAX_SHELL_OUTPUT_BYTES);
        const finalResult = formatFinalResult(
          "PS> ",
          command,
          exit,
          read.text,
          read.truncated,
          timeout,
        );
        unlinkQuiet(outputFile.path);
        settle(finalResult);
      };

      const backgroundExecution = (reason: BackgroundReason): string | null => {
        // `terminating` means a kill is already underway (abort, hard timeout,
        // output cap): such a command must report its terminal result inline,
        // not slip into the background between terminate() and close.
        if (
          backgrounded ||
          settled ||
          terminating ||
          !manager ||
          !backgroundAvailableHere
        ) {
          return null;
        }
        backgrounded = true;
        settled = true;
        // The command now outlives both its foreground timeout and the
        // caller's abort signal: only TaskStop or session shutdown can kill it.
        clearTimeout(timeoutTimer);
        ctx.abortSignal?.removeEventListener("abort", onAbort);
        this.foreground.delete(foregroundKey);

        const task = manager.create(
          backgroundTaskName(command),
          async () => {
            const exit = await done;
            const body = buildBackgroundBody(
              "PS> ",
              command,
              exit,
              outputFile.path,
              timeout,
            );
            if (body.isError) {
              throw new TaskFailure(body.output);
            }
            return body.output;
          },
          () => {
            // Immediate forced kill, no grace: the stop must land even during
            // CLI shutdown, and the process tree must not outlive the session.
            killTree("SIGKILL");
          },
          { originToolCallId: ctx.toolCallId, idPrefix: "ps", kind: "shell" },
        );
        resolve({
          output: backgroundMessage(reason, task.id, timeout),
          isError: false,
        });
        return task.id;
      };

      if (backgroundAvailableHere) {
        this.foreground.set(foregroundKey, {
          background: () => backgroundExecution("user") !== null,
        });
      }

      // The process is gone for good on error/close: stop the size watchdog
      // and any pending kill escalation so no timer outlives the command.
      const stopTimers = () => {
        clearInterval(watchdog);
        if (escalateTimer) {
          clearTimeout(escalateTimer);
        }
      };

      // Spawn-level failure (e.g. pwsh not installed): no close event guaranteed.
      child.on("error", (err) => {
        stopTimers();
        const hint =
          strArg(asRecord(err), "code") === "ENOENT" &&
          process.platform !== "win32"
            ? " (pwsh is required on macOS/Linux — install PowerShell Core)"
            : "";
        const exit: ShellExit = {
          code: null,
          signal: null,
          aborted,
          timedOut,
          sizeKilled,
          spawnError: `${err.message}${hint}`,
        };
        doneResolve?.(exit);
        settleExit(exit);
      });

      // With fd-mode stdio there are no parent-side pipes, so close fires when
      // the shell itself exits; grandchildren that inherit the output fd no
      // longer hold the result hostage.
      child.on("close", (code, signal) => {
        stopTimers();
        const exit: ShellExit = { code, signal, aborted, timedOut, sizeKilled };
        doneResolve?.(exit);
        settleExit(exit);
      });

      backgroundFn = backgroundExecution;
    });

    return {
      result,
      background: (reason) => backgroundFn?.(reason) ?? null,
    };
  }
}
