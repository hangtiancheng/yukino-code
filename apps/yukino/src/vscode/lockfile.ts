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

// Discovery of the Claude Code VSCode extension's embedded MCP server.
// The extension writes `~/.claude/ide/<port>.lock` on activation and injects
// CLAUDE_CODE_SSE_PORT into its integrated terminals; any CLI can use those
// to find and authenticate against the extension's WebSocket MCP server.

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import { z } from "zod";

import { createChildLogger } from "@/logger/index.js";

const log = createChildLogger({ module: "vscode" });

const LockfileSchema = z.object({
  workspaceFolders: z.array(z.string()).optional(),
  pid: z.number().optional(),
  ideName: z.string().optional(),
  transport: z.enum(["ws", "sse"]).optional(),
  authToken: z.string().optional(),
});

export interface DetectedIde {
  ideName: string;
  port: number;
  url: string;
  workspaceFolders: string[];
  authToken?: string;
  pid?: number;
}

function ideLockDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(configDir, "ide");
}

function cwdInWorkspace(cwd: string, workspaceFolders: string[]): boolean {
  // macOS returns NFD paths while VSCode reports NFC; normalize both sides.
  const normalizedCwd = cwd.normalize("NFC");
  return workspaceFolders.some((folder) => {
    if (!folder) {
      return false;
    }
    const resolved = resolve(folder).normalize("NFC");
    return (
      normalizedCwd === resolved || normalizedCwd.startsWith(resolved + sep)
    );
  });
}

async function readLockfile(
  dir: string,
  filename: string,
): Promise<DetectedIde | null> {
  const port = parseInt(filename.replace(".lock", ""), 10);
  if (Number.isNaN(port)) {
    return null;
  }
  try {
    const content = await readFile(join(dir, filename), "utf-8");
    const parsed = LockfileSchema.parse(JSON.parse(content));
    if (parsed.transport !== "ws") {
      // Legacy SSE lockfiles are not supported; modern extensions use ws.
      return null;
    }
    return {
      ideName: parsed.ideName ?? "IDE",
      port,
      url: `ws://127.0.0.1:${String(port)}`,
      workspaceFolders: parsed.workspaceFolders ?? [],
      authToken: parsed.authToken,
      pid: parsed.pid,
    };
  } catch (err) {
    log.error({ err, filename }, "failed to read IDE lockfile");
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Finds the extension instance for this terminal. A lockfile matches when its
// port equals CLAUDE_CODE_SSE_PORT (set by the extension in its integrated
// terminal), or as a fallback when cwd is inside its workspace folders and
// the match is unambiguous.
export async function detectIde(cwd: string): Promise<DetectedIde | null> {
  const dir = ideLockDir();
  let filenames: string[];
  try {
    filenames = (await readdir(dir)).filter((f) => f.endsWith(".lock"));
  } catch {
    return null; // no ~/.claude/ide directory → extension never ran
  }

  const lockfiles = (
    await Promise.all(filenames.map((f) => readLockfile(dir, f)))
  ).filter(
    // Stale lockfiles (extension crashed without cleanup) would win the
    // workspace match or make it ambiguous; drop entries with a dead pid.
    (l): l is DetectedIde =>
      l !== null && (l.pid === undefined || isPidAlive(l.pid)),
  );

  const envPort = process.env.CLAUDE_CODE_SSE_PORT
    ? parseInt(process.env.CLAUDE_CODE_SSE_PORT, 10)
    : null;
  if (envPort !== null) {
    const byPort = lockfiles.find((l) => l.port === envPort);
    if (byPort) {
      return byPort;
    }
  }

  const byWorkspace = lockfiles.filter((l) =>
    cwdInWorkspace(cwd, l.workspaceFolders),
  );
  return byWorkspace.length === 1 ? byWorkspace[0] : null;
}
