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
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { fileHistoryDir } from "@/file-history/index.js";

export type SaveClipboardImageResult =
  { ok: true; value: string } | { ok: false; reason: string };

const CLIPBOARD_TIMEOUT_MS = 5_000;
const MAX_CLIPBOARD_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const NO_IMAGE_MESSAGE = "The clipboard does not contain an image.";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export function isPngBuffer(bytes: Buffer): boolean {
  return (
    bytes.length > PNG_SIGNATURE.length &&
    bytes.subarray(0, 8).equals(PNG_SIGNATURE)
  );
}

// Mirrors the file-history backup naming scheme (sha256 hex prefix), so
// pasting the same image twice reuses the same file.
export function clipboardImageFileName(bytes: Buffer): string {
  return `${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.png`;
}

export async function storeClipboardImage(
  workDir: string,
  sessionId: string,
  bytes: Buffer,
): Promise<string> {
  if (!isPngBuffer(bytes)) {
    throw new Error("Clipboard data is not a PNG image.");
  }
  if (bytes.length > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new Error(
      `Clipboard image is too large (${String(bytes.length)} bytes, limit ${String(MAX_CLIPBOARD_IMAGE_BYTES)}).`,
    );
  }
  const dir = fileHistoryDir(workDir, sessionId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, clipboardImageFileName(bytes));
  await writeFile(path, bytes);
  return path;
}

interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

function run(
  command: string,
  args: readonly string[],
  extraEnv?: Record<string, string>,
): Promise<RunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });

    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const finish = (action: () => void): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        action();
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => {
        rejectPromise(
          new Error(
            `${command} timed out after ${String(CLIPBOARD_TIMEOUT_MS)}ms.`,
          ),
        );
      });
    }, CLIPBOARD_TIMEOUT_MS);

    if (!child.stdout || !child.stderr) {
      child.kill();
      finish(() => {
        rejectPromise(new Error(`${command} pipes were not created.`));
      });
      return;
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_CLIPBOARD_IMAGE_BYTES) {
        child.kill();
        finish(() => {
          rejectPromise(
            new Error(
              `${command} produced more than the clipboard image byte limit.`,
            ),
          );
        });
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = MAX_STDERR_BYTES - stderrBytes;
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        stderrBytes += retained.length;
        stderrChunks.push(retained);
      }
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish(() => {
        rejectPromise(
          err.code === "ENOENT"
            ? new Error(`${command} is not installed or not on PATH.`)
            : err,
        );
      });
    });
    child.on("close", (code) => {
      finish(() => {
        resolvePromise({
          code: code ?? 1,
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
        });
      });
    });
  });
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
    throw new Error(
      "No Wayland or X11 session found (WAYLAND_DISPLAY and DISPLAY are unset).",
    );
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
      lastError = new Error(
        `${err instanceof Error ? err.message : String(err)} ${backend.hint}`.trim(),
      );
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
 * `${workDir}/.yukino/file-history/${sessionId}/`. Returns the absolute file
 * path, ready to be referenced in a prompt and read back via ReadFile.
 */
export async function saveClipboardImage(
  workDir: string,
  sessionId: string,
): Promise<SaveClipboardImageResult> {
  const dir = fileHistoryDir(workDir, sessionId);
  const tempPath = join(dir, `.clipboard-${String(process.pid)}.tmp`);
  try {
    let bytes: Buffer;
    switch (process.platform) {
      case "darwin":
        await mkdir(dir, { recursive: true });
        bytes = await readMacClipboard(tempPath);
        break;
      case "linux":
        bytes = await readLinuxClipboard();
        break;
      case "win32":
        await mkdir(dir, { recursive: true });
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
      value: await storeClipboardImage(workDir, sessionId, bytes),
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}
