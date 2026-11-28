import { fileURLToPath } from "node:url";

import {
  getDefaultWritePaths,
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";

import { canonicalPath, isPathWithin, resolveToolPath } from "@/utils/paths.js";

export interface SandboxConfig {
  allowWrite: string[];
  /** Paths that are always read-only (takes precedence over allowWrite). */
  denyWrite: string[];
  networkEnabled: boolean;
}

export interface SandboxExecutionContext {
  shellPath?: string;
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
  readonly implementation: "sandbox-runtime";
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

export function createSandbox(): Promise<Sandbox | null> {
  return Promise.resolve(
    ["darwin", "linux"].includes(process.platform)
      ? new RuntimeSandbox()
      : null,
  );
}

export class RuntimeSandbox implements Sandbox {
  readonly implementation = "sandbox-runtime";
  availabilityError?: string;

  async available(): Promise<boolean> {
    const { errors } = await SandboxManager.checkDependenciesAsync();
    this.availabilityError = errors.length ? errors.join("; ") : undefined;
    return errors.length === 0;
  }

  prepare(
    command: string,
    config: SandboxConfig,
    context: SandboxExecutionContext,
  ): PreparedSandboxCommand {
    const paths = (values: string[]) =>
      values.map((path) => ({
        path: canonicalPath(resolveToolPath(context.cwd, path)),
        literal: true as const,
      }));
    const allowWrite = paths(config.allowWrite);
    const defaultDenies = getDefaultWritePaths().filter(
      (path) =>
        !path.startsWith("/dev/") &&
        !allowWrite.some((root) =>
          isPathWithin(canonicalPath(root.path), canonicalPath(path)),
        ),
    );
    const runtimeConfig: SandboxRuntimeConfig = {
      filesystem: {
        denyRead: [],
        allowWrite,
        denyWrite: paths([...config.denyWrite, ...defaultDenies]),
      },
      network: {
        allowedDomains: [],
        deniedDomains: [],
        strictAllowlist: !config.networkEnabled,
        allowLocalBinding: config.networkEnabled,
      },
    };
    return {
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./sandbox-worker.js", import.meta.url)),
        JSON.stringify({
          command,
          config: runtimeConfig,
          shellPath: context.shellPath ?? "bash",
          commandId: context.commandId,
        }),
      ],
    };
  }
}
