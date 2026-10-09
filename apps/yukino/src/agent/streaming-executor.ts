import { createChildLogger } from "@/logger/index.js";
import {
  observeToolExecution,
  type AgentTelemetry,
} from "@/telemetry/instrumentation.js";
import type { ToolRegistry } from "@/tools/registry.js";
import type { ToolResult, ToolContext } from "@/tools/types.js";
import { asErrorString } from "@/utils/index.js";

const log = createChildLogger({ module: "agent" });

interface PendingCall {
  toolId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  parseError?: string;
  approvedPermissionMode?: ToolContext["approvedPermissionMode"];
}

interface ExecutionResult {
  toolId: string;
  toolName: string;
  result: ToolResult;
  elapsed: number;
}

export class StreamingExecutor {
  private pending: PendingCall[] = [];
  private registry: ToolRegistry;
  private ctx: ToolContext;
  private telemetry: AgentTelemetry;

  constructor(
    registry: ToolRegistry,
    ctx: ToolContext,
    telemetry: AgentTelemetry,
  ) {
    this.registry = registry;
    this.ctx = ctx;
    this.telemetry = telemetry;
  }

  submit(
    toolId: string,
    toolName: string,
    args: Record<string, unknown>,
    parseError?: string,
  ): void {
    this.pending.push({
      toolId,
      toolName,
      arguments: args,
      approvedPermissionMode: this.ctx.permissionChecker?.mode,
      ...(parseError ? { parseError } : {}),
    });
  }

  async *runPending(): AsyncGenerator<ExecutionResult> {
    const calls = this.pending;
    this.pending = [];

    const completed: ExecutionResult[] = [];
    let wake: (() => void) | undefined;
    const executions = calls.map(async (call) => {
      const result = await this.executeCall(call);
      completed.push(result);
      wake?.();
      wake = undefined;
    });

    try {
      for (let index = 0; index < calls.length; index++) {
        if (index === completed.length) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        yield completed[index];
      }
    } finally {
      await Promise.all(executions);
    }
  }

  private async executeCall(call: PendingCall): Promise<ExecutionResult> {
    const start = Date.now();
    if (call.parseError) {
      return {
        toolId: call.toolId,
        toolName: call.toolName,
        result: {
          output: `Error: ${call.parseError}. The tool was not executed.`,
          isError: true,
        },
        elapsed: 0,
      };
    }

    const tool = this.registry.get(call.toolName);
    if (this.ctx.abortSignal?.aborted) {
      return {
        toolId: call.toolId,
        toolName: call.toolName,
        result: {
          output: "Tool execution was cancelled before it started.",
          isError: true,
        },
        elapsed: 0,
      };
    }

    // On invalid tool name, return a single error and let the model self-correct with another tool; keep the loop running.
    if (!tool) {
      return {
        toolId: call.toolId,
        toolName: call.toolName,
        result: {
          output: `Error: unknown tool '${call.toolName}'`,
          isError: true,
        },
        elapsed: 0,
      };
    }

    try {
      const result = await observeToolExecution(
        call.toolName,
        () =>
          tool.execute(
            {
              ...this.ctx,
              toolCallId: call.toolId,
              approvedPermissionMode: call.approvedPermissionMode,
            },
            call.arguments,
          ),
        this.telemetry,
      );
      return {
        toolId: call.toolId,
        toolName: call.toolName,
        result,
        elapsed: (Date.now() - start) / 1000,
      };
    } catch (err) {
      log.error({ err }, "agent operation failed");
      return {
        toolId: call.toolId,
        toolName: call.toolName,
        result: {
          output: `Error executing ${call.toolName}: ${asErrorString(err)}`,
          isError: true,
        },
        elapsed: (Date.now() - start) / 1000,
      };
    }
  }
}
