import { dirname } from "node:path";

import { isSafeCommand } from "@/permissions/index.js";
import type {
  PreparedSandboxCommand,
  Sandbox,
  SandboxConfig,
} from "@/sandbox/index.js";
import { SANDBOX_UNAVAILABLE_ERROR } from "@/tools/constants.js";
import {
  BASH_BACKGROUND_DESCRIPTION,
  BASH_COMMAND_DESCRIPTION,
  BASH_DESCRIPTION,
} from "@/tools/prompts.js";
import { ShellTool } from "@/tools/shell-tool.js";
import type { ToolContext } from "@/tools/types.js";
import { asErrorString } from "@/utils/index.js";
import { resolveToolPath } from "@/utils/paths.js";

export class BashTool extends ShellTool {
  name = "Bash";
  description = BASH_DESCRIPTION;
  protected commandDescription = BASH_COMMAND_DESCRIPTION;
  protected backgroundDescription = BASH_BACKGROUND_DESCRIPTION;
  protected prefix = "bash";
  protected prompt = "$ ";

  shellPath?: string;
  shellCommandPrefix?: string;
  sandbox: Sandbox | null = null;
  sandboxRequired = false;
  sandboxConfig: SandboxConfig = {
    allowWrite: [],
    denyWrite: [],
    networkEnabled: true,
  };

  permissionArguments(args: Record<string, unknown>): Record<string, unknown> {
    const { command } = args;
    return this.shellCommandPrefix?.trim() &&
      typeof command === "string" &&
      command
      ? { ...args, command: `${this.shellCommandPrefix}\n${command}` }
      : args;
  }

  async dispose(): Promise<void> {
    await this.sandbox?.dispose?.();
    this.sandbox = null;
  }

  isConcurrencySafe(args: Record<string, unknown>): boolean {
    const command = this.permissionArguments(args).command;
    return typeof command === "string" && isSafeCommand(command);
  }

  protected async prepareCommand(
    ctx: ToolContext,
    command: string,
    outputPath: string,
  ): Promise<PreparedSandboxCommand> {
    const shellPath = this.shellPath || "bash";
    const executable =
      shellPath.includes("/") || shellPath.includes("\\") || shellPath === "~"
        ? resolveToolPath(ctx.cwd, shellPath)
        : shellPath;
    const sandbox = this.sandbox;
    if (!sandbox) {
      if (this.sandboxRequired) {
        throw new Error(SANDBOX_UNAVAILABLE_ERROR);
      }
      return { executable, args: ["-c", command] };
    }

    try {
      if (await sandbox.available()) {
        const prepared = await sandbox.prepare(
          command,
          {
            ...this.sandboxConfig,
            // Bind-based sandboxes need the stable output directory to mount.
            allowWrite: [
              ...(ctx.permissionChecker?.sandboxWriteRoots(
                this.sandboxConfig.allowWrite,
              ) ?? this.sandboxConfig.allowWrite),
              dirname(outputPath),
            ],
          },
          {
            cwd: ctx.cwd,
            abortSignal: ctx.abortSignal,
            commandId: ctx.toolCallId,
            shellPath: executable,
          },
        );
        const tempDirectory = ctx.permissionChecker?.sandboxTempDirectory();
        if (tempDirectory) {
          prepared.env = {
            ...process.env,
            ...prepared.env,
            TMPDIR: tempDirectory,
            TMP: tempDirectory,
            TEMP: tempDirectory,
          };
        }
        return prepared;
      }
    } catch (error) {
      throw new Error(`Error preparing sandbox: ${asErrorString(error)}`, {
        cause: error,
      });
    }
    throw new Error(
      `Error: ${sandbox.implementation} sandbox is unavailable${sandbox.availabilityError ? ` (${sandbox.availabilityError})` : ""}; command was not executed`,
    );
  }
}
