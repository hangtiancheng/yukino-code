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

import { existsSync, statSync } from "node:fs";

import type { Sandbox, SandboxConfig } from "./index.js";

// Hardcoded path to prevent PATH injection attacks
const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

/**
 * macOS seatbelt sandbox implementation.
 * Dynamically generates a seatbelt profile to control file write and network access permissions.
 */
export class SeatbeltSandbox implements Sandbox {
  readonly implementation = "seatbelt";

  available(): boolean {
    return existsSync(SANDBOX_EXEC_PATH);
  }

  prepare(
    command: string,
    config: SandboxConfig,
  ): { executable: string; args: string[] } {
    return {
      executable: SANDBOX_EXEC_PATH,
      args: ["-p", buildProfile(config), "bash", "-c", command],
    };
  }
}

/**
 * Dynamically builds a seatbelt profile string.
 * Strategy: deny by default, then allow execution and reads, grant writes per path,
 * deny writes per path, and finally configure network access.
 */
function buildProfile(config: SandboxConfig): string {
  const lines: string[] = [];

  lines.push("(version 1)");
  lines.push("(deny default)");

  // Allow process execution and forking
  lines.push("(allow process-exec)");
  lines.push("(allow process-fork)");
  // Allow reading system control parameters
  lines.push("(allow sysctl-read)");
  // Allow reading the entire filesystem
  lines.push('(allow file-read* (subpath "/"))');

  // Grant write access for allowed paths
  for (const path of config.allowWrite) {
    lines.push(`(allow file-write* (subpath "${path}"))`);
  }

  // Deny write access for denied paths; seatbelt evaluates later rules with higher priority.
  // Use 'literal' for exact file matching, 'subpath' for directory prefix matching.
  for (const path of config.denyWrite) {
    const matcher =
      existsSync(path) && statSync(path).isDirectory() ? "subpath" : "literal";
    lines.push(`(deny file-write* (${matcher} "${path}"))`);
  }

  // Network access control
  if (config.networkEnabled) {
    lines.push("(allow network*)");
  } else {
    lines.push("(deny network*)");
  }

  return lines.join("\n");
}
