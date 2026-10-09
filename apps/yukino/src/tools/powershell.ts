import { execFile, spawn } from "node:child_process";
import { statSync } from "node:fs";

import {
  POWERSHELL_BACKGROUND_DESCRIPTION,
  POWERSHELL_DESCRIPTION,
} from "./descriptions.js";
import { withCommandExecution } from "./execution-coordinator.js";
import {
  BACKGROUND_NOTIFICATION_BYTES,
  MAX_SHELL_OUTPUT_FILE_BYTES,
  SIZE_WATCHDOG_INTERVAL_MS,
  backgroundMessage,
  backgroundTaskName,
  buildShellResult,
  createShellOutputFile,
  discardFd,
  unlinkQuiet,
  type BackgroundReason,
  type CommandHandle,
  type ShellExit,
} from "./shell-background.js";
import {
  type Tool,
  type ToolCategory,
  type ToolContext,
  type ToolResult,
  type ToolSchema,
} from "./types.js";

import { registerExitCleanup } from "@/bootstrap/exit-cleanup.js";
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

  execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    return withCommandExecution(
      ctx,
      this.name,
      args,
      strArg(args, "command"),
      (started) => this.executeCommand(ctx, args, started),
    );
  }

  private async executeCommand(
    ctx: ToolContext,
    args: Record<string, unknown>,
    started: (done: Promise<void>) => void,
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

    // No OS-sandbox wrapping here: both sandboxes wrap bash
    // (`... bash -c '...'` — seatbelt and bwrap alike), and
    // Windows — this tool's primary platform — has no OS sandbox support anyway.
    const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";

    let outputFile: { path: string; fd: number };
    try {
      outputFile = createShellOutputFile(ctx.sessionId ?? "");
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
    started(handle.done);
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
    let finishProcess: () => void = () => undefined;
    const processDone = new Promise<void>((resolve) => {
      finishProcess = resolve;
    });
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
          cwd: ctx.cwd,
          // Only POSIX needs its own process group for kill(-pid); the Windows
          // tree kill goes through taskkill and needs no new group.
          detached: process.platform !== "win32",
          // stdout and stderr share one output fd, opened O_APPEND on POSIX so
          // each write lands atomically and the streams interleave
          // chronologically (see openOutputFd for the Windows fallback).
          stdio: ["ignore", outputFile.fd, outputFile.fd],
        });
      } catch (error) {
        finishProcess();
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
      // when the group is already gone or the tree kill fails. The
      // alreadyExited() guard prevents pid reuse: once the child is reaped its
      // pid may belong to an unrelated process, and taskkill/kill by stale pid
      // could take down someone else's process.
      const killTree = (signal: NodeJS.Signals) => {
        if (typeof child.pid !== "number" || alreadyExited()) {
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

      // Direct file writes bypass JS, so poll size to enforce the disk cap.
      const watchdog = setInterval(() => {
        let size = 0;
        try {
          size = statSync(outputFile.path).size;
        } catch {
          return;
        }
        if (size > MAX_SHELL_OUTPUT_FILE_BYTES) {
          sizeKilled = true;
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
      let timedOut = false;
      const timeoutTimer = ctx.shellTimeoutDisabled
        ? undefined
        : setTimeout(() => {
            if (backgroundExecution("timeout") !== null) {
              return;
            }
            timedOut = true;
            terminate();
          }, timeout * 1000);
      timeoutTimer?.unref();

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

      const settleExit = (exit: ShellExit) => {
        if (backgrounded) {
          return;
        }
        const finalResult = buildShellResult(
          "PS> ",
          command,
          exit,
          outputFile.path,
          timeout,
        );
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
        // caller's abort signal: only TaskStop, session shutdown, or the
        // background output cap (watchdog keeps running at the 5GB ceiling)
        // can kill it.
        clearTimeout(timeoutTimer);
        ctx.abortSignal?.removeEventListener("abort", onAbort);
        this.foreground.delete(foregroundKey);
        // Release the workspace mutation lock now: the command has left the
        // foreground, so it must not keep serializing every other command in
        // this cwd for the rest of its (possibly unbounded) background life.
        finishProcess();

        const task = manager.create(
          backgroundTaskName(command),
          async () => {
            const exit = await done;
            const body = buildShellResult(
              "PS> ",
              command,
              exit,
              outputFile.path,
              timeout,
              BACKGROUND_NOTIFICATION_BYTES,
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
        // Crash-path orphan prevention: process.exit() (terminal gone,
        // uncaught exception) never reaches the task manager's stop, so the
        // recover.ts sweep kills this process tree synchronously instead.
        const unregisterCleanup = registerExitCleanup(() => {
          killTree("SIGKILL");
        });
        void task.done.finally(unregisterCleanup);
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
        finishProcess();
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
        finishProcess();
        stopTimers();
        const exit: ShellExit = { code, signal, aborted, timedOut, sizeKilled };
        doneResolve?.(exit);
        settleExit(exit);
      });

      backgroundFn = backgroundExecution;
    });

    return {
      done: processDone,
      result,
      background: (reason) => backgroundFn?.(reason) ?? null,
    };
  }
}
