import { createWriteStream, statSync, type WriteStream } from "node:fs";

import { execa, type ResultPromise } from "execa";

import { registerExitCleanup } from "@/bootstrap/exit-cleanup.js";
import type { PreparedSandboxCommand } from "@/sandbox/index.js";
import { TaskFailure, type TaskManager } from "@/subagent/task-manager.js";
import {
  BACKGROUND_NOTIFICATION_BYTES,
  COMMAND_INTERRUPTED_ERROR,
  KILL_GRACE_MS,
  MAX_SHELL_OUTPUT_BYTES,
  MAX_SHELL_OUTPUT_FILE_BYTES,
  SIZE_WATCHDOG_INTERVAL_MS,
} from "@/tools/constants.js";
import { backgroundMessage } from "@/tools/prompts.js";
import {
  backgroundTaskName,
  buildShellResult,
  discardFd,
  readOutputFile,
  unlinkQuiet,
  type BackgroundReason,
  type CommandHandle,
  type ShellExit,
} from "@/tools/shell-background.js";
import type { ToolContext, ToolResult } from "@/tools/types.js";
import { asErrorString } from "@/utils/index.js";

let nextCommandId = 0;

function startShellCommand(options: {
  ctx: ToolContext;
  prepared: PreparedSandboxCommand;
  command: string;
  timeout: number;
  outputFile: { path: string; fd: number };
  manager: TaskManager | null;
  foreground: Map<string, { background: () => boolean }>;
  prefix: string;
  prompt: string;
}): CommandHandle {
  const {
    ctx,
    prepared,
    command,
    timeout,
    outputFile,
    manager,
    foreground,
    prefix,
    prompt,
  } = options;
  const result = Promise.withResolvers<ToolResult>();
  const completion = Promise.withResolvers<ShellExit>();
  const processDone = Promise.withResolvers<undefined>();
  const foregroundKey = `${prefix}-${String(nextCommandId++)}`;
  let backgrounded = false;
  let exited = false;
  let terminating = false;
  let aborted = false;
  let timedOut = false;
  let sizeKilled = false;
  let lastOutputSize = 0;
  let child: ResultPromise<{
    buffer: false;
    reject: false;
    stdin: "ignore";
    stdout: WriteStream;
    stderr: WriteStream;
  }>;
  try {
    const output = createWriteStream(outputFile.path, {
      fd: outputFile.fd,
      autoClose: false,
    });
    child = execa(prepared.executable, prepared.args, {
      cwd: ctx.cwd,
      env: prepared.env ?? process.env,
      extendEnv: false,
      stdin: "ignore",
      stdout: output,
      stderr: output,
      buffer: false,
      reject: false,
      killDescendants: true,
      forceKillAfterDelay: KILL_GRACE_MS,
    });
  } catch (error) {
    discardFd(outputFile.fd);
    unlinkQuiet(outputFile.path);
    processDone.resolve(undefined);
    result.resolve({
      output: `Error executing command: ${asErrorString(error)}`,
      isError: true,
    });
    return {
      done: processDone.promise,
      result: result.promise,
      background: () => null,
    };
  }
  discardFd(outputFile.fd);
  const terminate = () => {
    if (!terminating && !exited) {
      terminating = true;
      child.kill();
    }
  };
  const forceStop = () => {
    if (!exited) {
      child.kill("SIGKILL");
    }
  };
  const unregisterCleanup = registerExitCleanup(forceStop);
  const watchdog = setInterval(() => {
    let size: number;
    try {
      size = statSync(outputFile.path).size;
    } catch {
      return;
    }
    if (!backgrounded && ctx.onOutput && size !== lastOutputSize) {
      lastOutputSize = size;
      try {
        ctx.onOutput(readOutputFile(outputFile.path, 50 * 1024, true).text);
      } catch {
        /* Observer failures cannot stop execution. */
      }
    }
    if (size > MAX_SHELL_OUTPUT_FILE_BYTES) {
      sizeKilled = true;
      terminate();
    }
  }, SIZE_WATCHDOG_INTERVAL_MS);
  watchdog.unref();
  const onAbort = () => {
    aborted = true;
    terminate();
  };
  const timeoutTimer = ctx.shellTimeoutDisabled
    ? undefined
    : setTimeout(() => {
        if (background("timeout") === null) {
          timedOut = true;
          terminate();
        }
      }, timeout * 1000);
  timeoutTimer?.unref();
  const detachForeground = () => {
    clearTimeout(timeoutTimer);
    ctx.abortSignal?.removeEventListener("abort", onAbort);
    foreground.delete(foregroundKey);
    processDone.resolve(undefined);
  };
  const annotate = prepared.annotateStderr
    ? (text: string) => prepared.annotateStderr?.(text) ?? text
    : undefined;
  const background = (reason: BackgroundReason): string | null => {
    if (backgrounded || exited || terminating || !manager) {
      return null;
    }
    const task = manager.create(
      backgroundTaskName(command),
      async () => {
        const exit = await completion.promise;
        try {
          await prepared.cleanup?.();
        } catch {
          /* Preserve the command result. */
        }
        const body = buildShellResult(
          prompt,
          command,
          exit,
          outputFile.path,
          timeout,
          BACKGROUND_NOTIFICATION_BYTES,
          annotate,
        );
        if (body.isError) {
          throw new TaskFailure(body.output);
        }
        return body.output;
      },
      forceStop,
      {
        context: ctx,
        originToolCallId: ctx.toolCallId,
        idPrefix: prefix,
        kind: "shell",
      },
    );
    backgrounded = true;
    detachForeground();
    result.resolve({
      output: backgroundMessage(reason, task.id, timeout),
      isError: false,
    });
    return task.id;
  };
  if (manager) {
    foreground.set(foregroundKey, {
      background: () => background("user") !== null,
    });
  }
  ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });
  if (ctx.abortSignal?.aborted) {
    onAbort();
  }
  const finish = async (exit: ShellExit) => {
    if (exited) {
      return;
    }
    exited = true;
    clearInterval(watchdog);
    unregisterCleanup();
    detachForeground();
    completion.resolve(exit);
    if (backgrounded) {
      return;
    }
    const finalResult = buildShellResult(
      prompt,
      command,
      exit,
      outputFile.path,
      timeout,
      MAX_SHELL_OUTPUT_BYTES,
      annotate,
    );
    try {
      await prepared.cleanup?.();
      result.resolve(finalResult);
    } catch (error) {
      result.resolve({
        output: `${finalResult.output}\nError cleaning up sandbox: ${asErrorString(error)}`,
        isError: true,
      });
    }
  };
  void child.then(
    (exit) =>
      finish({
        code: exit.exitCode ?? null,
        signal: exit.signal ?? null,
        aborted,
        timedOut,
        sizeKilled,
        ...(exit.failed && exit.exitCode === undefined && !exit.signal
          ? { spawnError: exit.message }
          : {}),
      }),
    (error: unknown) =>
      finish({
        code: null,
        signal: null,
        aborted,
        timedOut,
        sizeKilled,
        spawnError: asErrorString(error),
      }),
  );
  return { done: processDone.promise, result: result.promise, background };
}

export async function executeShellCommand(
  options: Parameters<typeof startShellCommand>[0] & {
    started: (done: Promise<void>) => void;
    runInBackground?: boolean;
  },
): Promise<ToolResult> {
  if (options.ctx.abortSignal?.aborted) {
    discardFd(options.outputFile.fd);
    unlinkQuiet(options.outputFile.path);
    try {
      await options.prepared.cleanup?.();
    } catch {
      // Interruption remains the primary result before the command starts.
    }
    return { output: COMMAND_INTERRUPTED_ERROR, isError: true };
  }
  const handle = startShellCommand(options);
  options.started(handle.done);
  if (options.runInBackground) {
    const taskId = handle.background("explicit");
    if (taskId !== null) {
      return {
        output: backgroundMessage("explicit", taskId, options.timeout),
        isError: false,
      };
    }
  }
  return handle.result;
}
