import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exitCodeHint } from "./exit-code-hints.js";
import type { ToolRegistry } from "./registry.js";
import { formatShellOutput, MAX_SHELL_OUTPUT_BYTES } from "./shell-output.js";
import type { ToolResult } from "./types.js";

import type { TaskManager } from "@/subagent/task-manager.js";
import {
  buildPersistedOutputPreview,
  spillDir,
  TOOL_RESULT_PREVIEW_CHARS,
} from "@/tool-result/index.js";

// Shared background-execution plumbing for the backgroundable tools (Bash,
// PowerShell): ccb's file-descriptor output mode, the size watchdog
// constants, result/notification formatting, and the host wiring helpers.

/** Notification body budget: larger outputs stay on disk and only a preview travels in the notification. */
export const BACKGROUND_NOTIFICATION_CHARS = 30_000;
/**
 * ccb parity: a backgrounded command may fill up to 5GB before the size
 * watchdog kills it (their incident: a stuck append loop wrote 768GB with no
 * JS in the write path to notice). Foreground keeps the historical 10MB cap.
 */
export const BACKGROUND_MAX_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024;
export const SIZE_WATCHDOG_INTERVAL_MS = 500;

/** Why a command moved to the background. */
export type BackgroundReason = "explicit" | "user" | "timeout";

/** Terminal facts about the child process, consumed to build results and notifications. */
export interface ShellExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  aborted: boolean;
  timedOut: boolean;
  sizeKilled: boolean;
  spawnError?: string;
}

export interface CommandHandle {
  /** Resolves the tool call: either the inline completion or an early "moved to background" message. */
  result: Promise<ToolResult>;
  /**
   * Move the running command to the background. Returns the background task ID,
   * or null when the command already finished or backgrounding is unavailable.
   */
  background: (reason: BackgroundReason) => string | null;
}

/**
 * Whether a command may be *automatically* backgrounded on timeout. Bare
 * sleeps are killed instead: backgrounding one would just hold a task slot
 * until session end. Explicit run_in_background and manual Ctrl+B are always
 * honored regardless of this gate. Only the first token is considered:
 * `sleep 60` should die on timeout, but `npm run build && sleep 1` is a real
 * workload worth keeping alive.
 */
export function isAutobackgroundingAllowed(
  command: string,
  disallowed: ReadonlySet<string>,
): boolean {
  const first = /^\S+/.exec(command.trimStart())?.[0] ?? "";
  const base = first
    .replace(/^.*\//, "")
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
  return !disallowed.has(base);
}

export function backgroundTaskName(command: string): string {
  const flat = command.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

export function backgroundMessage(
  reason: BackgroundReason,
  taskId: string,
  timeout: number,
): string {
  switch (reason) {
    case "explicit":
      return `Command running in background (task_id: ${taskId}). You will be notified when it completes; do not poll. Use TaskStop with task_id to kill it early.`;
    case "timeout":
      return `Command exceeded its ${String(timeout)}s timeout and was moved to the background (task_id: ${taskId}). It is still running — you will be notified when it completes.`;
    case "user":
      return `Command was manually backgrounded by the user (task_id: ${taskId}). It is still running — you will be notified when it completes.`;
  }
}

/** Slice buf to at most maxBytes, ending on a UTF-8 character boundary. */
export function sliceUtf8Safe(buf: Buffer, maxBytes: number): Buffer {
  if (buf.length <= maxBytes) {
    return buf;
  }
  let end = maxBytes;
  // Landed on a continuation byte: back up to the start of the sequence and
  // drop it rather than emitting a broken character.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--;
  }
  return buf.subarray(0, end);
}

/** Read at most maxBytes of the output file; missing files read as empty. */
export function readOutputFile(
  path: string,
  maxBytes: number,
): { text: string; size: number; truncated: boolean } {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { text: "", size: 0, truncated: false };
  }
  try {
    const size = fstatSync(fd).size;
    // One lookahead byte lets sliceUtf8Safe detect a cut inside a code point.
    const readLen = Math.min(size, maxBytes + 1);
    const buf = Buffer.alloc(readLen);
    let bytesRead = 0;
    while (bytesRead < readLen) {
      const count = readSync(
        fd,
        buf,
        bytesRead,
        readLen - bytesRead,
        bytesRead,
      );
      if (count === 0) {
        break;
      }
      bytesRead += count;
    }
    return {
      text: sliceUtf8Safe(buf.subarray(0, bytesRead), maxBytes).toString(
        "utf-8",
      ),
      size,
      truncated: size > maxBytes,
    };
  } finally {
    closeSync(fd);
  }
}

export function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

export function discardFd(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    /* already closed */
  }
}

export function openOutputFd(path: string): number {
  // O_APPEND makes each write atomic on POSIX so the shared stdout+stderr
  // interleave chronologically without tearing; O_NOFOLLOW stops a pre-planted
  // symlink from redirecting output. Windows/MSYS2 treats append-only handles
  // as read-only and silently discards writes, so use plain "w" there.
  const flags =
    process.platform === "win32"
      ? "w"
      : fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_APPEND |
        fsConstants.O_NOFOLLOW;
  return openSync(path, flags, 0o600);
}

/**
 * Create the file that receives a command's stdout+stderr. Lives in the
 * session tool-results directory (the established spill location, readable by
 * the model for backgrounded commands); falls back to the OS temp dir when
 * that directory cannot be created.
 */
export function createShellOutputFile(
  workDir: string,
  sessionId: string,
): {
  path: string;
  fd: number;
} {
  const fileName = `shell-${randomBytes(8).toString("hex")}.output`;
  const candidates: string[] = [];
  try {
    const dir = spillDir(workDir, sessionId);
    mkdirSync(dir, { recursive: true });
    candidates.push(join(dir, fileName));
  } catch {
    // Session dir unusable (e.g. read-only workdir) — fall through to temp.
  }
  candidates.push(join(tmpdir(), fileName));

  let lastError: unknown = new Error("no candidate output directory");
  for (const path of candidates) {
    try {
      return { path, fd: openOutputFd(path) };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Build the foreground tool result from exit facts and the captured output.
 * Shared verbatim by the inline foreground path and the background task
 * notification body, so both report identically. `prompt` is the tool's shell
 * marker ("$ " for Bash, "PS> " for PowerShell).
 */
export function formatFinalResult(
  prompt: string,
  command: string,
  exit: ShellExit,
  merged: string,
  truncated: boolean,
  timeout: number,
): ToolResult {
  if (exit.spawnError) {
    return {
      output: `Error executing command: ${exit.spawnError}`,
      isError: true,
    };
  }
  if (exit.aborted || exit.timedOut) {
    const captured =
      merged || truncated
        ? formatShellOutput(prompt, command, merged, "", truncated)
        : "";
    const error = exit.aborted
      ? "Error: command interrupted"
      : `Error: command timed out after ${String(timeout)}s`;
    return {
      output: captured ? `${captured}\n${error}` : error,
      isError: true,
    };
  }

  const exitCode = exit.code ?? 0;
  let output = formatShellOutput(prompt, command, merged, "", truncated);

  if (!truncated) {
    if (exitCode !== 0) {
      const hint = exitCodeHint(command, exitCode);
      output += hint
        ? `\nExit code ${String(exitCode)} (${hint})`
        : `\nExit code ${String(exitCode)}`;
    }

    if (exit.code === null) {
      output += `\nProcess terminated${exit.signal ? ` by ${exit.signal}` : " unexpectedly"}`;
    }
  }

  return { output, isError: truncated || exitCode !== 0 || exit.code === null };
}

/**
 * Build the notification body for a finished background command from the
 * output file. Small outputs are inlined and the file is deleted; large
 * outputs keep the file on disk and the notification carries its path with a
 * 2000-char preview, so the full text stays readable via ReadFile without ever
 * loading it into JS here. `annotate` is the sandbox's stderr annotator
 * (sandbox-runtime violation notes); the foreground path applies it in
 * settleExit, and background notifications must report identically.
 */
export function buildBackgroundBody(
  prompt: string,
  command: string,
  exit: ShellExit,
  outputPath: string,
  timeout: number,
  annotate?: (text: string) => string,
): ToolResult {
  let size = 0;
  try {
    size = statSync(outputPath).size;
  } catch {
    // File vanished; report with empty output below.
  }

  let result: ToolResult;
  if (size <= BACKGROUND_NOTIFICATION_CHARS) {
    const read = readOutputFile(outputPath, MAX_SHELL_OUTPUT_BYTES);
    const merged = annotate ? annotate(read.text) : read.text;
    result = formatFinalResult(
      prompt,
      command,
      exit,
      merged,
      read.truncated,
      timeout,
    );
    unlinkQuiet(outputPath);
  } else {
    const header = formatFinalResult(prompt, command, exit, "", false, timeout);
    const preview = readOutputFile(outputPath, TOOL_RESULT_PREVIEW_CHARS).text;
    result = {
      output: `${header.output}\n${buildPersistedOutputPreview(size, annotate ? annotate(preview) : preview, outputPath)}`,
      isError: header.isError,
    };
  }

  if (exit.sizeKilled) {
    result.output += "\nBackground command killed: output file exceeded 5GB";
    result.isError = true;
  }
  return result;
}

/** The subset of a tool instance the host wiring below needs. */
export interface BackgroundableTool {
  taskManager: TaskManager | null;
  backgroundEnabled(): boolean;
  hasForegroundTasks(): boolean;
  backgroundForegroundTasks(): number;
}

/** Tools that support background execution, in Ctrl+B priority order. */
export const BACKGROUNDABLE_TOOL_NAMES = ["Bash", "PowerShell"] as const;

function asBackgroundable(tool: unknown): BackgroundableTool | null {
  if (
    typeof tool === "object" &&
    tool !== null &&
    "taskManager" in tool &&
    "backgroundForegroundTasks" in tool
  ) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return tool as BackgroundableTool;
  }
  return null;
}

/**
 * Share one background task registry across every backgroundable tool in the
 * registry, so run_in_background, Ctrl+B and timeout auto-background deliver
 * results through the same task-notification drain as background agents.
 */
export function attachBackgroundTaskManager(
  registry: ToolRegistry,
  manager: TaskManager,
): void {
  for (const name of BACKGROUNDABLE_TOOL_NAMES) {
    const tool = asBackgroundable(registry.get(name));
    if (tool) {
      tool.taskManager = manager;
    }
  }
}

/**
 * Whether any backgroundable tool has a running foreground task. Gates the
 * Ctrl+B handler: the keypress must stay inert when nothing is running, so
 * other components that also bind Ctrl+B (e.g. the provider-login form's
 * cursor-back) don't double-fire.
 */
export function hasAnyForegroundTasks(registry: ToolRegistry): boolean {
  for (const name of BACKGROUNDABLE_TOOL_NAMES) {
    const tool = asBackgroundable(registry.get(name));
    if (tool?.hasForegroundTasks()) {
      return true;
    }
  }
  return false;
}

/**
 * Move every running foreground task of every backgroundable tool to the
 * background (the Ctrl+B action). Returns how many were backgrounded.
 */
export function backgroundAllForegroundTasks(registry: ToolRegistry): number {
  let count = 0;
  for (const name of BACKGROUNDABLE_TOOL_NAMES) {
    const tool = asBackgroundable(registry.get(name));
    if (tool) {
      count += tool.backgroundForegroundTasks();
    }
  }
  return count;
}
