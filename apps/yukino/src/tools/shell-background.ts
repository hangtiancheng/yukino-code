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

import z from "zod";

import { exitCodeHint } from "./exit-code-hints.js";
import type { ToolRegistry } from "./registry.js";
import { formatShellOutput, MAX_SHELL_OUTPUT_BYTES } from "./shell-output.js";
import { TaskOutputTool } from "./task-output.js";
import type { ToolResult } from "./types.js";

import { TaskManager } from "@/subagent/task-manager.js";
import {
  buildPersistedOutputPreview,
  spillDir,
  TOOL_RESULT_PREVIEW_CHARS,
} from "@/tool-result/index.js";

// Shared background-execution plumbing for the backgroundable tools (Bash,
// PowerShell): the file-descriptor output mode, the size watchdog
// constants, result/notification formatting, and the host wiring helpers.

/** Notification body budget: larger outputs stay on disk and only a preview travels in the notification. */
export const BACKGROUND_NOTIFICATION_BYTES = 30_000;
const SHELL_OUTPUT_PREVIEW_BYTES = TOOL_RESULT_PREVIEW_CHARS;
/** Disk cap for foreground and background commands, independent of display limits. */
export const MAX_SHELL_OUTPUT_FILE_BYTES = 5 * 1024 * 1024 * 1024;
export const SIZE_WATCHDOG_INTERVAL_MS = 500;

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
  done: Promise<void>;
  /** Resolves the tool call: either the inline completion or an early "moved to background" message. */
  result: Promise<ToolResult>;
  /**
   * Move the running command to the background. Returns the background task ID,
   * or null when the command already finished or backgrounding is unavailable.
   */
  background: (reason: BackgroundReason) => string | null;
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
  tail = false,
): { text: string; size: number; truncated: boolean } {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { text: "", size: 0, truncated: false };
  }
  try {
    const size = fstatSync(fd).size;
    const offset = tail ? Math.max(0, size - maxBytes) : 0;
    // One lookahead byte lets sliceUtf8Safe detect a cut inside a code point.
    const readLen = Math.min(size - offset, maxBytes + 1);
    const buf = Buffer.alloc(readLen);
    let bytesRead = 0;
    while (bytesRead < readLen) {
      const count = readSync(
        fd,
        buf,
        bytesRead,
        readLen - bytesRead,
        offset + bytesRead,
      );
      if (count === 0) {
        break;
      }
      bytesRead += count;
    }
    let start = 0;
    if (offset > 0) {
      while (start < bytesRead && (buf[start] & 0xc0) === 0x80) {
        start++;
      }
    }
    return {
      text: sliceUtf8Safe(buf.subarray(start, bytesRead), maxBytes).toString(
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
 * the model for large command outputs); falls back to the OS temp dir when
 * that directory cannot be created.
 */
export function createShellOutputFile(sessionId: string): {
  path: string;
  fd: number;
} {
  const fileName = `shell-${randomBytes(8).toString("hex")}.output`;
  const candidates: string[] = [];
  try {
    const dir = spillDir(sessionId);
    mkdirSync(dir, { recursive: true });
    candidates.push(join(dir, fileName));
  } catch {
    // Session storage unavailable — fall through to temp.
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

  if (exitCode !== 0) {
    const hint = exitCodeHint(command, exitCode);
    output += hint
      ? `\nExit code ${String(exitCode)} (${hint})`
      : `\nExit code ${String(exitCode)}`;
  }

  if (exit.code === null) {
    output += `\nProcess terminated${exit.signal ? ` by ${exit.signal}` : " unexpectedly"}`;
  }
  if (exit.sizeKilled) {
    output += "\nCommand killed: output file exceeded 5GB";
  }

  return {
    output,
    isError: exitCode !== 0 || exit.code === null || exit.sizeKilled,
  };
}

/**
 * Build a finished command's result from its output file. Small outputs are
 * inlined and the file is deleted; large outputs stay on disk with a
 * byte-bounded preview, so the full text stays readable via ReadFile without
 * loading it into JS. `annotate` adds sandbox violation notes to captured output.
 */
export function buildShellResult(
  prompt: string,
  command: string,
  exit: ShellExit,
  outputPath: string,
  timeout: number,
  inlineLimit = MAX_SHELL_OUTPUT_BYTES,
  annotate?: (text: string) => string,
): ToolResult {
  let size = 0;
  try {
    size = statSync(outputPath).size;
  } catch {
    // File vanished; report with empty output below.
  }

  const read = readOutputFile(
    outputPath,
    size > inlineLimit ? SHELL_OUTPUT_PREVIEW_BYTES : inlineLimit,
  );
  if (size <= inlineLimit && !read.truncated) {
    const merged = annotate ? annotate(read.text) : read.text;
    const result = formatFinalResult(
      prompt,
      command,
      exit,
      merged,
      read.truncated,
      timeout,
    );
    unlinkQuiet(outputPath);
    return result;
  }

  const header = formatFinalResult(prompt, command, exit, "", false, timeout);
  const annotatedPreview = annotate ? annotate(read.text) : read.text;
  const preview = sliceUtf8Safe(
    Buffer.from(annotatedPreview, "utf-8"),
    SHELL_OUTPUT_PREVIEW_BYTES,
  ).toString("utf-8");
  return {
    output: `${header.output}\n${buildPersistedOutputPreview(read.size, preview, outputPath, "bytes")}`,
    isError: header.isError,
  };
}

const BackgroundableToolShape = z.object({
  taskManager: z.instanceof(TaskManager).nullable(),
  backgroundEnabled: z.function({ input: [], output: z.boolean() }),
  hasForegroundTasks: z.function({ input: [], output: z.boolean() }),
  backgroundForegroundTasks: z.function({ input: [], output: z.number() }),
});

export type BackgroundableTool = z.infer<typeof BackgroundableToolShape>;

// Preserve the original instance so manager injection and methods share its state.
const BackgroundableToolSchema = z.custom<BackgroundableTool>(
  (tool) => BackgroundableToolShape.safeParse(tool).success,
);

/** Tools that support background execution; Ctrl+B handling iterates this list. */
export const BACKGROUNDABLE_TOOL_NAMES = ["Bash", "PowerShell"] as const;

function asBackgroundable(tool: unknown): BackgroundableTool | null {
  const parsed = BackgroundableToolSchema.safeParse(tool);
  return parsed.success ? parsed.data : null;
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
  registry.getInstanceOf("TaskOutput", TaskOutputTool)?.setTaskManager(manager);
  for (const name of BACKGROUNDABLE_TOOL_NAMES) {
    const tool = asBackgroundable(registry.get(name));
    if (tool) {
      tool.taskManager = manager;
    }
  }
}

/**
 * Whether any backgroundable tool has a running foreground task. Gates the
 * Ctrl+B handler: the keypress stays inert when nothing is backgroundable.
 * (The handler separately yields to the provider-login form while it is open —
 * that form also binds Ctrl+B, for cursor-back.)
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
