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

import { spawn } from "node:child_process";
import { statSync } from "node:fs";

import {
  BASH_BACKGROUND_DESCRIPTION,
  BASH_DESCRIPTION,
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

import { isSafeCommand } from "@/permissions/index.js";
import type {
  PreparedSandboxCommand,
  Sandbox,
  SandboxConfig,
} from "@/sandbox/index.js";
import { TaskFailure, type TaskManager } from "@/subagent/task-manager.js";
import { asErrorString, boolArg, intArg, strArg } from "@/utils/index.js";

const MAX_TIMEOUT = 600;
// Grace period between SIGTERM and the SIGKILL escalation when terminating a command.
const KILL_GRACE_MS = 3000;
// Bare sleeps are killed on timeout instead of auto-backgrounded: backgrounding one
// would just hold a task slot until session end.
const DISALLOWED_AUTO_BACKGROUND_COMMANDS = new Set(["sleep"]);

export class BashTool implements Tool {
  // Use a hardcoded string instead of BashTool.name.replace("Tool", "")
  // because class names are not stable after minification — bundlers like
  // Terser/esbuild may rename or mangle them, producing incorrect tool names at runtime.
  name = "Bash";

  description: string = BASH_DESCRIPTION;
  category: ToolCategory = "command";

  // OS-level sandbox instance and config, injected externally
  sandbox: Sandbox | null = null;
  sandboxRequired = false;
  sandboxConfig: SandboxConfig = {
    allowWrite: [],
    denyWrite: [],
    networkEnabled: true,
  };

  /**
   * Background task registry, injected by the host (UI / print mode / remote
   * server) — the same instance the Agent tool uses, so completion
   * notifications share one drain and TaskStop covers both. When null, Bash is
   * foreground-only: run_in_background disappears from the schema, timeouts
   * kill, and Ctrl+B is a no-op. Calls running inside a subagent loop carry
   * that loop's own manager in ctx.taskManager, which takes precedence.
   */
  taskManager: TaskManager | null = null;

  /** Running foreground executions eligible for manual backgrounding (Ctrl+B). */
  private foreground = new Map<string, { background: () => boolean }>();
  private nextForegroundId = 1;

  /**
   * Read-only commands can run concurrently with other read-only tools;
   * mutating commands must run exclusively.
   *
   * Commands like ls, cat, git status don't mutate external state — same as
   * ReadFile — so there's no risk of interference. But rm, mv, npm install
   * would break the model's intended execution order if run concurrently.
   * The check reuses the permission layer's safe-command allowlist; redirects,
   * pipes, command chaining, and command substitution are already excluded.
   */
  isConcurrencySafe(args: Record<string, unknown>): boolean {
    const command = args.command;
    return typeof command === "string" && isSafeCommand(command);
  }

  /**
   * The background subsystem needs a task manager and can be disabled
   * wholesale with YUKINO_DISABLE_BACKGROUND_TASKS=1 (schema parameter
   * removed, timeouts kill, Ctrl+B becomes a no-op). Instance-level gate used
   * by the schema; execute() re-checks with the ctx-resolved manager.
   */
  backgroundEnabled(): boolean {
    return (
      this.taskManager !== null &&
      process.env.YUKINO_DISABLE_BACKGROUND_TASKS !== "1"
    );
  }

  /** True while at least one foreground Bash command runs (gates the Ctrl+B handler). */
  hasForegroundTasks(): boolean {
    return this.foreground.size > 0;
  }

  /**
   * Move every running foreground Bash command to the background (Ctrl+B).
   * Returns how many commands were actually backgrounded.
   */
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
        description: "Shell command to execute",
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
      description = `${this.description}\n${BASH_BACKGROUND_DESCRIPTION}`;
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

    let outputFile: { path: string; fd: number };
    try {
      outputFile = createShellOutputFile(ctx.workDir, ctx.sessionId ?? "");
    } catch (error) {
      return {
        output: `Error creating output file: ${asErrorString(error)}`,
        isError: true,
      };
    }
    const discardOutputFile = () => {
      discardFd(outputFile.fd);
      unlinkQuiet(outputFile.path);
    };

    let prepared: PreparedSandboxCommand = {
      executable: "bash",
      args: ["-c", command],
    };
    if (this.sandboxRequired || this.sandbox) {
      if (!this.sandbox) {
        discardOutputFile();
        return {
          output:
            "Error: sandbox is enabled but unavailable; command was not executed",
          isError: true,
        };
      }
      try {
        if (!(await this.sandbox.available())) {
          discardOutputFile();
          return {
            output: `Error: ${this.sandbox.implementation} sandbox is unavailable; command was not executed`,
            isError: true,
          };
        }
        prepared = await this.sandbox.prepare(
          command,
          {
            ...this.sandboxConfig,
            // The child writes its output file directly; grant write access to
            // that path even under a strict allowWrite config.
            allowWrite: [...this.sandboxConfig.allowWrite, outputFile.path],
          },
          {
            cwd: ctx.workDir,
            abortSignal: ctx.abortSignal,
            commandId: ctx.toolCallId,
          },
        );
      } catch (error) {
        discardOutputFile();
        return {
          output: `Error preparing sandbox: ${asErrorString(error)}`,
          isError: true,
        };
      }
    }

    if (ctx.abortSignal?.aborted) {
      discardOutputFile();
      try {
        await prepared.cleanup?.();
      } catch {
        // The command never started, so interruption remains the primary result.
      }
      return {
        output: "Error: command interrupted",
        isError: true,
      };
    }

    const handle = this.startCommand(
      ctx,
      prepared,
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
   * Spawn the command with stdout+stderr writing directly into the output
   * file (ccb's file-descriptor mode): output never flows through JS, so
   * backgrounding is a bookkeeping switch — no re-spawn, no buffer handover.
   * The returned handle exposes the tool-call promise plus a background()
   * trigger that transitions the running command into a TaskManager task.
   */
  private startCommand(
    ctx: ToolContext,
    prepared: PreparedSandboxCommand,
    command: string,
    timeout: number,
    outputFile: { path: string; fd: number },
    manager: TaskManager | null,
  ): CommandHandle {
    // Async execution keeps the Node event loop free: with spawnSync the UI
    // froze (spinner animation, elapsed timers, keyboard input) for the whole
    // command duration.
    //
    // Timeout and abort are handled manually instead of via spawn's built-in
    // timeout/signal options: those only SIGTERM the direct child, so a
    // command that spawns children (dev servers, npm scripts) or traps
    // SIGTERM keeps running and the callback never fires, wedging the agent
    // loop and making Esc appear dead. `detached` puts the child in its own
    // process group so the whole tree can be killed, with SIGKILL escalation
    // for processes that ignore SIGTERM.
    let backgroundFn: ((reason: BackgroundReason) => string | null) | undefined;
    const result = new Promise<ToolResult>((resolve) => {
      let aborted = false;
      let terminating = false;
      let settled = false;
      let backgrounded = false;
      let sizeKilled = false;
      let escalateTimer: NodeJS.Timeout | null = null;

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(prepared.executable, prepared.args, {
          cwd: ctx.workDir,
          detached: true,
          env: prepared.env,
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

      // Kill the child's whole process group; fall back to the direct child
      // when the group is already gone (or group kill is unsupported).
      const killTree = (signal: NodeJS.Signals) => {
        if (typeof child.pid !== "number") {
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
      // The sleep blocklist gates *automatic* backgrounding only; explicit
      // run_in_background and manual Ctrl+B are always honored.
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

      const foregroundKey = `bash-${String(this.nextForegroundId++)}`;

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
          // background (its task runner owns sandbox cleanup from here).
          return;
        }
        settled = true;
        cleanup();
        const finalize = async () => {
          await prepared.cleanup?.();
        };
        void finalize().then(
          () => {
            resolve(finalResult);
          },
          (error: unknown) => {
            resolve({
              output: `${finalResult.output}\nError cleaning up sandbox: ${asErrorString(error)}`,
              isError: true,
            });
          },
        );
      };

      // Foreground completion: read the output back (capped), inline it, and
      // delete the now-redundant file.
      const settleExit = (exit: ShellExit) => {
        if (backgrounded) {
          return;
        }
        const read = readOutputFile(outputFile.path, MAX_SHELL_OUTPUT_BYTES);
        const merged = prepared.annotateStderr?.(read.text) ?? read.text;
        const finalResult = formatFinalResult(
          "$ ",
          command,
          exit,
          merged,
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
        // caller's abort signal: only TaskStop or session shutdown can kill
        // it. (A termination already underway is excluded by the
        // `terminating` guard above, so no escalate timer can be pending here.)
        clearTimeout(timeoutTimer);
        ctx.abortSignal?.removeEventListener("abort", onAbort);
        this.foreground.delete(foregroundKey);

        const task = manager.create(
          backgroundTaskName(command),
          async () => {
            const exit = await done;
            try {
              await prepared.cleanup?.();
            } catch {
              // Sandbox teardown trouble must not swallow the command result.
            }
            // Wrap the method: passing prepared.annotateStderr directly would
            // unbind it from `prepared` (and trip unbound-method).
            const annotate = prepared.annotateStderr
              ? (text: string): string =>
                  prepared.annotateStderr?.(text) ?? text
              : undefined;
            const body = buildBackgroundBody(
              "$ ",
              command,
              exit,
              outputFile.path,
              timeout,
              annotate,
            );
            if (body.isError) {
              throw new TaskFailure(body.output);
            }
            return body.output;
          },
          () => {
            // Immediate SIGKILL, no SIGTERM grace: the stop must land even
            // during CLI shutdown, and the detached process group must not
            // outlive the session.
            killTree("SIGKILL");
          },
          { originToolCallId: ctx.toolCallId, idPrefix: "bash", kind: "shell" },
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
      // and any pending kill escalation so no timer outlives the command
      // (the foreground settle path clears them again, harmlessly).
      const stopTimers = () => {
        clearInterval(watchdog);
        if (escalateTimer) {
          clearTimeout(escalateTimer);
        }
      };

      // Spawn-level failure (e.g. bash not found): no close event guaranteed.
      child.on("error", (error) => {
        stopTimers();
        const exit: ShellExit = {
          code: null,
          signal: null,
          aborted,
          timedOut,
          sizeKilled,
          spawnError: error.message,
        };
        doneResolve?.(exit);
        settleExit(exit);
      });

      // With fd-mode stdio there are no parent-side pipes, so close fires when
      // the shell itself exits; grandchildren that inherit the output fd (e.g.
      // `cmd &`) no longer hold the result hostage.
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
