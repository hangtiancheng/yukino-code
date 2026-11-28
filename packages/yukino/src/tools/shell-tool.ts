import { z } from "zod";

import type { PreparedSandboxCommand } from "@/sandbox/index.js";
import type { TaskManager } from "@/subagent/task-manager.js";
import { DEFAULT_TIMEOUT, MAX_TIMEOUT } from "@/tools/constants.js";
import { withCommandExecution } from "@/tools/execution-coordinator.js";
import {
  RUN_IN_BACKGROUND_DESCRIPTION,
  SHELL_TIMEOUT_DESCRIPTION,
} from "@/tools/prompts.js";
import { createToolSchema } from "@/tools/schema.js";
import {
  createShellOutputFile,
  discardFd,
  unlinkQuiet,
} from "@/tools/shell-background.js";
import { executeShellCommand } from "@/tools/shell-process.js";
import type {
  Tool,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@/tools/types.js";
import { asErrorString } from "@/utils/index.js";

export abstract class ShellTool implements Tool {
  abstract name: string;
  abstract description: string;
  protected abstract commandDescription: string;
  protected abstract backgroundDescription: string;
  protected abstract prefix: string;
  protected abstract prompt: string;
  readonly category = "command" as const;
  taskManager: TaskManager | null = null;

  private foreground = new Map<string, { background: () => boolean }>();

  permissionArguments?(args: Record<string, unknown>): Record<string, unknown>;

  protected abstract prepareCommand(
    ctx: ToolContext,
    command: string,
    outputPath: string,
  ): PreparedSandboxCommand | Promise<PreparedSandboxCommand>;

  backgroundEnabled(): boolean {
    return this.taskManager !== null;
  }

  hasForegroundTasks(): boolean {
    return this.foreground.size > 0;
  }

  backgroundForegroundTasks(): number {
    let count = 0;
    for (const entry of [...this.foreground.values()]) {
      if (entry.background()) {
        count++;
      }
    }
    return count;
  }

  parameters(backgroundEnabled = this.backgroundEnabled()) {
    return z.strictObject({
      command: z.string().min(1).describe(this.commandDescription),
      timeout: z
        .number()
        .int()
        .positive()
        .max(MAX_TIMEOUT)
        .default(DEFAULT_TIMEOUT)
        .describe(SHELL_TIMEOUT_DESCRIPTION),
      ...(backgroundEnabled
        ? {
            run_in_background: z
              .boolean()
              .default(false)
              .describe(RUN_IN_BACKGROUND_DESCRIPTION),
          }
        : {}),
    });
  }

  schema(): ToolSchema {
    return createToolSchema(
      this.name,
      this.backgroundEnabled()
        ? `${this.description}\n${this.backgroundDescription}`
        : this.description,
      this.parameters(),
    );
  }

  async execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const parameters = this.parameters(
      this.backgroundEnabled() || Boolean(ctx.taskManager),
    );
    const input = parameters.safeParse(args);
    if (!input.success) {
      return { output: input.error.message, isError: true };
    }
    const commandArgs = this.permissionArguments
      ? parameters.parse(this.permissionArguments(input.data))
      : input.data;
    const {
      command,
      timeout,
      run_in_background: runInBackground,
    } = commandArgs;
    // A loop can explicitly disable backgrounding even when the host has a manager.
    const manager =
      ctx.taskManager === undefined ? this.taskManager : ctx.taskManager;
    return withCommandExecution(
      ctx,
      this.name,
      commandArgs,
      command,
      async (started) => {
        let outputFile: ReturnType<typeof createShellOutputFile>;
        try {
          outputFile = createShellOutputFile(ctx.sessionId ?? "", ctx);
        } catch (error) {
          return {
            output: `Error creating output file: ${asErrorString(error)}`,
            isError: true,
          };
        }
        let prepared: PreparedSandboxCommand;
        try {
          prepared = await this.prepareCommand(ctx, command, outputFile.path);
        } catch (error) {
          discardFd(outputFile.fd);
          unlinkQuiet(outputFile.path);
          return { output: asErrorString(error), isError: true };
        }
        return executeShellCommand({
          started,
          runInBackground: runInBackground === true,
          ctx,
          prepared,
          command,
          timeout,
          outputFile,
          manager,
          foreground: this.foreground,
          prefix: this.prefix,
          prompt: this.prompt,
        });
      },
    );
  }
}
