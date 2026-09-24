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

import os from "node:os";

// Submodule namespaces for library consumers (Sandbox.<Sub>.*).
export * as Bwrap from "./bwrap.js";
export * as SandboxRuntime from "./sandbox-runtime.js";
export * as Seatbelt from "./seatbelt.js";

export type SandboxBackend = "native" | "sandbox-runtime";
export type SandboxImplementation = "bwrap" | "sandbox-runtime" | "seatbelt";

/**
 * Sandbox configuration: controls file write permissions and network access.
 */
export interface SandboxConfig {
  /** Paths where write operations are permitted. */
  allowWrite: string[];
  /** Paths that are always read-only (takes precedence over allowWrite). */
  denyWrite: string[];
  /** Whether network access is allowed. */
  networkEnabled: boolean;
}

export interface SandboxExecutionContext {
  cwd: string;
  abortSignal?: AbortSignal;
  commandId?: string;
}

export interface PreparedSandboxCommand {
  executable: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  annotateStderr?(stderr: string): string;
  cleanup?(): Promise<void> | void;
}

/**
 * Unified sandbox interface with platform-specific implementations for macOS and Linux.
 */
export interface Sandbox {
  readonly implementation: SandboxImplementation;
  readonly availabilityError?: string;
  /** Checks whether the platform sandbox tooling is available. */
  available(): boolean | Promise<boolean>;
  /** Prepares an executable and argv for sandboxed execution. */
  prepare(
    command: string,
    config: SandboxConfig,
    context: SandboxExecutionContext,
  ): PreparedSandboxCommand | Promise<PreparedSandboxCommand>;
  /** Releases session-level resources held by the sandbox. */
  dispose?(): Promise<void> | void;
}

/**
 * Creates the requested sandbox backend.
 * native: seatbelt on macOS, bubblewrap on Linux.
 */
export async function createSandbox(
  backend: SandboxBackend = "native",
): Promise<Sandbox | null> {
  if (backend === "sandbox-runtime") {
    const { SandboxRuntimeSandbox } = await import("./sandbox-runtime.js");
    return new SandboxRuntimeSandbox();
  }

  const platform = os.platform();
  if (platform === "darwin") {
    const { SeatbeltSandbox } = await import("./seatbelt.js");
    return new SeatbeltSandbox();
  }
  if (platform === "linux") {
    const { BwrapSandbox } = await import("./bwrap.js");
    return new BwrapSandbox();
  }
  return null;
}
