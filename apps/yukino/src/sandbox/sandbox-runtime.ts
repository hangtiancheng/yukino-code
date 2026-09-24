import { isAbsolute, resolve } from "node:path";

import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

import type {
  PreparedSandboxCommand,
  Sandbox,
  SandboxConfig,
  SandboxExecutionContext,
} from "./index.js";

async function loadSandboxRuntime() {
  return await import("@anthropic-ai/sandbox-runtime");
}

function resolvePaths(paths: string[], cwd: string): string[] {
  return paths.map((path) => (isAbsolute(path) ? path : resolve(cwd, path)));
}

export function createSandboxRuntimeConfig(
  config: SandboxConfig,
  cwd: string,
): SandboxRuntimeConfig {
  return {
    network: {
      allowedDomains: [],
      deniedDomains: config.networkEnabled ? [] : ["*"],
      strictAllowlist: !config.networkEnabled,
    },
    filesystem: {
      denyRead: [],
      allowWrite: resolvePaths(config.allowWrite, cwd),
      denyWrite: resolvePaths(config.denyWrite, cwd),
      allowGitConfig: false,
    },
  };
}

export class SandboxRuntimeSandbox implements Sandbox {
  readonly implementation = "sandbox-runtime";
  availabilityError?: string;

  private availabilityPromise?: Promise<boolean>;
  private configKey?: string;
  private initializationPromise?: Promise<void>;
  private runtimePromise?: ReturnType<typeof loadSandboxRuntime>;

  available(): Promise<boolean> {
    return (this.availabilityPromise ??= this.checkAvailability());
  }

  async prepare(
    command: string,
    config: SandboxConfig,
    context: SandboxExecutionContext,
  ): Promise<PreparedSandboxCommand> {
    if (!(await this.available())) {
      throw new Error(
        this.availabilityError ?? "sandbox runtime is unavailable",
      );
    }

    const runtime = await this.loadRuntime();
    const runtimeConfig = runtime.SandboxRuntimeConfigSchema.parse(
      createSandboxRuntimeConfig(config, context.cwd),
    );
    const configKey = JSON.stringify(runtimeConfig);

    if (this.initializationPromise) {
      await this.initializationPromise;
    }
    if (
      this.configKey !== configKey ||
      !runtime.SandboxManager.isSandboxingEnabled()
    ) {
      this.initializationPromise = (async () => {
        if (runtime.SandboxManager.isSandboxingEnabled()) {
          await runtime.SandboxManager.reset();
        }
        await runtime.SandboxManager.initialize(
          runtimeConfig,
          config.networkEnabled ? () => Promise.resolve(true) : undefined,
        );
        this.configKey = configKey;
      })();
      try {
        await this.initializationPromise;
      } finally {
        this.initializationPromise = undefined;
      }
    }

    const commandId = context.commandId ?? command;
    const prepared = await runtime.SandboxManager.wrapWithSandboxArgv(
      command,
      "/bin/bash",
      undefined,
      context.abortSignal,
      context.cwd,
      { commandId, commandText: command },
    );
    const [executable, ...args] = prepared.argv;
    if (!executable) {
      throw new Error("sandbox runtime returned an empty command");
    }

    return {
      executable,
      args,
      env: prepared.env,
      annotateStderr: (stderr) =>
        runtime.SandboxManager.annotateStderrWithSandboxFailures(
          commandId,
          stderr,
        ),
      cleanup: () => {
        runtime.SandboxManager.cleanupAfterCommand();
      },
    };
  }

  async dispose(): Promise<void> {
    if (!this.runtimePromise) {
      return;
    }
    await this.initializationPromise;
    const runtime = await this.runtimePromise;
    await runtime.SandboxManager.reset();
    this.configKey = undefined;
  }

  private async checkAvailability(): Promise<boolean> {
    try {
      const runtime = await this.loadRuntime();
      if (!runtime.SandboxManager.isSupportedPlatform()) {
        this.availabilityError =
          "sandbox runtime does not support this platform";
        return false;
      }
      const dependencies =
        await runtime.SandboxManager.checkDependenciesAsync();
      if (dependencies.errors.length > 0) {
        this.availabilityError = dependencies.errors.join("; ");
        return false;
      }
      this.availabilityError = undefined;
      return true;
    } catch (error) {
      this.availabilityError =
        error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  private loadRuntime(): ReturnType<typeof loadSandboxRuntime> {
    return (this.runtimePromise ??= loadSandboxRuntime());
  }
}
