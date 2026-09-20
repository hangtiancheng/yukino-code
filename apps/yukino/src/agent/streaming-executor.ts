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

import { createChildLogger } from "@/logger/index.js";
import { observeToolExecution, type AgentTelemetry } from "@/telemetry/instrumentation.js";
import type { ToolRegistry } from "@/tools/registry.js";
import type { ToolResult, ToolContext } from "@/tools/types.js";
import { asErrorString } from "@/utils/index.js";

const log = createChildLogger({ module: "agent" });

interface PendingCall {
  toolId: string;
  toolName: string;
  arguments: Record<string, unknown>;
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

  constructor(registry: ToolRegistry, ctx: ToolContext, telemetry: AgentTelemetry) {
    this.registry = registry;
    this.ctx = ctx;
    this.telemetry = telemetry;
  }

  submit(toolId: string, toolName: string, args: Record<string, unknown>): void {
    this.pending.push({ toolId, toolName, arguments: args });
  }

  async collectResults(): Promise<ExecutionResult[]> {
    const calls = [...this.pending];
    this.pending = [];

    const promises = calls.map(async (call) => {
      const tool = this.registry.get(call.toolName);
      const start = Date.now();
      if (this.ctx.abortSignal?.aborted) {
        return {
          toolId: call.toolId,
          toolName: call.toolName,
          result: { output: "Tool execution was cancelled before it started.", isError: true },
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
          () => tool.execute({ ...this.ctx, toolCallId: call.toolId }, call.arguments),
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
    });

    return Promise.all(promises);
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }
}
