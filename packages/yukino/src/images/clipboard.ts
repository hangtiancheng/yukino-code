import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { execa } from "execa";

import { fileHistoryDir } from "@/file-history/index.js";
import {
  CLIPBOARD_NOT_PNG_ERROR,
  CLIPBOARD_NO_SESSION_ERROR,
  CLIPBOARD_TIMEOUT_MS,
  MAX_CLIPBOARD_IMAGE_BYTES,
  MAX_STDERR_BYTES,
  NO_IMAGE_MESSAGE,
} from "@/images/constants.js";
import { sniffMediaType } from "@/images/media-type.js";
import { mkdirPrivateSync, writePrivateFile } from "@/storage/private.js";
import { asErrorString } from "@/utils/format.js";

export type SaveClipboardImageResult =
  { ok: true; value: string } | { ok: false; reason: string };

export async function isPngBuffer(bytes: Buffer): Promise<boolean> {
  return (await sniffMediaType(bytes)) === "image/png";
}

// Mirrors the file-history backup naming scheme (sha256 hex prefix), so
// pasting the same image twice reuses the same file.
export function clipboardImageFileName(bytes: Buffer): string {
  return `${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.png`;
}

export async function storeClipboardImage(
  sessionId: string,
  bytes: Buffer,
): Promise<string> {
  if (!(await isPngBuffer(bytes))) {
    throw new Error(CLIPBOARD_NOT_PNG_ERROR);
  }
  if (bytes.length > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new Error(
      `Clipboard image is too large (${String(bytes.length)} bytes, limit ${String(MAX_CLIPBOARD_IMAGE_BYTES)}).`,
    );
  }
  const dir = fileHistoryDir(sessionId);
  mkdirPrivateSync(dir);
  const path = join(dir, clipboardImageFileName(bytes));
  await writePrivateFile(path, bytes);
  return path;
}

interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

async function run(
  command: string,
  args: readonly string[],
  extraEnv?: Record<string, string>,
): Promise<RunResult> {
  const result = await execa(command, args, {
    env: extraEnv,
    stdin: "ignore",
    encoding: "buffer",
    timeout: CLIPBOARD_TIMEOUT_MS,
    maxBuffer: { stdout: MAX_CLIPBOARD_IMAGE_BYTES, stderr: MAX_STDERR_BYTES },
    killDescendants: true,
    reject: false,
  });
  if (result.timedOut) {
    throw new Error(
      `${command} timed out after ${String(CLIPBOARD_TIMEOUT_MS)}ms.`,
    );
  }
  if (result.isMaxBuffer) {
    throw new Error(`${command} produced more than the clipboard byte limit.`);
  }
  if (result.code === "ENOENT") {
    throw new Error(`${command} is not installed or not on PATH.`);
  }
  if (result.failed && result.exitCode === undefined) {
    throw new Error(result.message);
  }
  return {
    code: result.exitCode ?? 1,
    stdout: Buffer.from(result.stdout),
    stderr: Buffer.from(result.stderr).toString("utf8").trim(),
  };
}

const MACOS_SCRIPT_LINES = [
  "on run argv",
  "set d to the clipboard as «class PNGf»",
  "set f to open for access POSIX file (item 1 of argv) with write permission",
  "set eof f to 0",
  "write d to f",
  "close access f",
  "end run",
];

async function readMacClipboard(tempPath: string): Promise<Buffer> {
  const args = [
    ...MACOS_SCRIPT_LINES.flatMap((line) => ["-e", line]),
    tempPath,
  ];
  const result = await run("/usr/bin/osascript", args);
  if (result.code !== 0) {
    // AppleScript error -1700: clipboard content can't coerce to PNG data.
    if (result.stderr.includes("-1700")) {
      throw new Error(NO_IMAGE_MESSAGE);
    }
    throw new Error(
      `osascript failed: ${result.stderr || `exit ${String(result.code)}`}`,
    );
  }
  return readFile(tempPath);
}

async function readLinuxClipboard(): Promise<Buffer> {
  const backends: { command: string; args: string[]; hint: string }[] = [];
  if (process.env.WAYLAND_DISPLAY) {
    backends.push({
      command: "wl-paste",
      args: ["--no-newline", "--type", "image/png"],
      hint: "Install wl-clipboard (provides wl-paste).",
    });
  }
  if (process.env.DISPLAY) {
    backends.push({
      command: "xclip",
      args: ["-selection", "clipboard", "-t", "image/png", "-o"],
      hint: "Install xclip with your system package manager.",
    });
  }
  if (backends.length === 0) {
    throw new Error(CLIPBOARD_NO_SESSION_ERROR);
  }

  let lastError = new Error(NO_IMAGE_MESSAGE);
  for (const backend of backends) {
    try {
      const result = await run(backend.command, backend.args);
      if (result.code === 0 && result.stdout.length > 0) {
        return result.stdout;
      }
      const detail = result.stderr.toLowerCase();
      lastError =
        detail.includes("target") ||
        detail.includes("no suitable") ||
        detail.includes("nothing")
          ? new Error(NO_IMAGE_MESSAGE)
          : new Error(
              `${backend.command} failed: ${result.stderr || `exit ${String(result.code)}`}`,
            );
    } catch (err) {
      lastError = new Error(`${asErrorString(err)} ${backend.hint}`.trim());
    }
  }
  throw lastError;
}

const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$img = [System.Windows.Forms.Clipboard]::GetImage()",
  "if ($null -eq $img) { exit 3 }",
  "$img.Save($env:YUKINO_CLIPBOARD_PATH, [System.Drawing.Imaging.ImageFormat]::Png)",
  "$img.Dispose()",
].join("; ");

async function readWindowsClipboard(tempPath: string): Promise<Buffer> {
  const result = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Sta", "-Command", WINDOWS_SCRIPT],
    { YUKINO_CLIPBOARD_PATH: tempPath },
  );
  if (result.code === 3) {
    throw new Error(NO_IMAGE_MESSAGE);
  }
  if (result.code !== 0) {
    throw new Error(
      `powershell failed: ${result.stderr || `exit ${String(result.code)}`}`,
    );
  }
  return readFile(tempPath);
}

/**
 * Read an image from the system clipboard and save it as a PNG under
 * `~/.yukino/sessions/artifacts/${sessionId}/file-history/`. On success, `value` is the
 * absolute file path, ready to be referenced in a prompt and read back via
 * ReadFile; on failure, `reason` explains why.
 */
export async function saveClipboardImage(
  sessionId: string,
): Promise<SaveClipboardImageResult> {
  const dir = fileHistoryDir(sessionId);
  const tempPath = join(dir, `.clipboard-${String(process.pid)}.tmp`);
  try {
    let bytes: Buffer;
    switch (process.platform) {
      case "darwin":
        mkdirPrivateSync(dir);
        bytes = await readMacClipboard(tempPath);
        break;
      case "linux":
        bytes = await readLinuxClipboard();
        break;
      case "win32":
        mkdirPrivateSync(dir);
        bytes = await readWindowsClipboard(tempPath);
        break;
      default:
        return {
          ok: false,
          reason: `Clipboard image paste is not supported on ${process.platform}.`,
        };
    }
    if (bytes.length === 0) {
      return { ok: false, reason: NO_IMAGE_MESSAGE };
    }
    return {
      ok: true,
      value: await storeClipboardImage(sessionId, bytes),
    };
  } catch (err) {
    return {
      ok: false,
      reason: asErrorString(err),
    };
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}
