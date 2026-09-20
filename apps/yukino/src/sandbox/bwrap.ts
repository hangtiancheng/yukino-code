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

import { execFileSync } from "node:child_process";

import type { Sandbox, SandboxConfig } from "./index.js";

/**
 * Linux bubblewrap (bwrap) sandbox implementation.
 * Leverages Linux user namespaces to create lightweight isolated environments.
 */
export class BwrapSandbox implements Sandbox {
  readonly implementation = "bwrap";

  private detected?: boolean;

  available(): boolean {
    if (this.detected !== undefined) {
      return this.detected;
    }
    try {
      execFileSync("which", ["bwrap"], { stdio: "ignore" });
      this.detected = true;
    } catch {
      this.detected = false;
    }
    return this.detected;
  }

  prepare(command: string, config: SandboxConfig): { executable: string; args: string[] } {
    const args = ["--unshare-user", "--unshare-pid"];

    // Mount the root filesystem as read-only
    args.push("--ro-bind", "/", "/");

    // Grant write access via writable bind mounts for allowed paths
    for (const path of config.allowWrite) {
      args.push("--bind", path, path);
    }

    // Enforce read-only on denied paths (overrides writable root mount sub-paths)
    for (const path of config.denyWrite) {
      args.push("--ro-bind", path, path);
    }

    // Network isolation
    if (!config.networkEnabled) {
      args.push("--unshare-net");
    }

    // Mount /proc, required by many commands
    args.push("--proc", "/proc");

    // Append the command to execute
    args.push("--", "bash", "-c", command);

    return { executable: "bwrap", args };
  }
}
