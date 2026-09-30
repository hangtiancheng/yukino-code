import os from "node:os";

// Submodule namespaces for library consumers (Sandbox.<Sub>.*).
export * as Bwrap from "./bwrap.js";
export * as Seatbelt from "./seatbelt.js";

export type SandboxImplementation = "bwrap" | "seatbelt";

export interface SandboxConfig {
  allowWrite: string[];
  /** Paths that are always read-only (takes precedence over allowWrite). */
  denyWrite: string[];
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
 * Unified sandbox interface: seatbelt on macOS, bubblewrap on Linux.
 */
export interface Sandbox {
  readonly implementation: SandboxImplementation;
  readonly availabilityError?: string;
  available(): boolean | Promise<boolean>;
  prepare(
    command: string,
    config: SandboxConfig,
    context: SandboxExecutionContext,
  ): PreparedSandboxCommand | Promise<PreparedSandboxCommand>;
  /** Releases session-level resources held by the sandbox. */
  dispose?(): Promise<void> | void;
}

/**
 * Creates the platform sandbox: seatbelt on macOS, bubblewrap on Linux.
 * Returns null on other platforms.
 */
export async function createSandbox(): Promise<Sandbox | null> {
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
