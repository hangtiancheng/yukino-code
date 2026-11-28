import { z } from "zod";

import {
  CODE_MODE_MAX_OUTPUT_TOKENS,
  CODE_MODE_TIMEOUT_MS,
  CODE_MODE_TOOL_NAME,
  VM_MAX_SOURCE_CHARS,
} from "@/code-mode/constants.js";
import { CodeModeExecution } from "@/code-mode/execution.js";
import {
  CODE_MODE_CODE_DESCRIPTION,
  CODE_MODE_DESCRIPTION,
  CODE_MODE_OUTPUT_DESCRIPTION,
  CODE_MODE_TIMEOUT_DESCRIPTION,
} from "@/code-mode/prompts.js";
import {
  acquireSessionRunLease,
  type SessionRunLeaseHandle,
} from "@/session/lease.js";
import { resolveSessionStorageTarget } from "@/subagent/task-manager.js";
import { createToolSchema } from "@/tools/schema.js";
import type {
  Tool,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@/tools/types.js";
import { asErrorString } from "@/utils/index.js";

const CodeModeInputSchema = z.strictObject({
  code: z
    .string()
    .min(1)
    .max(VM_MAX_SOURCE_CHARS)
    .describe(CODE_MODE_CODE_DESCRIPTION),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(3_600_000)
    .default(CODE_MODE_TIMEOUT_MS)
    .describe(CODE_MODE_TIMEOUT_DESCRIPTION),
  max_output_tokens: z
    .number()
    .int()
    .positive()
    .max(100_000)
    .default(CODE_MODE_MAX_OUTPUT_TOKENS)
    .describe(CODE_MODE_OUTPUT_DESCRIPTION),
});

export class CodeModeTool implements Tool {
  name = CODE_MODE_TOOL_NAME;
  description = CODE_MODE_DESCRIPTION;
  category = "read" as const;
  private active = new Set<CodeModeExecution>();
  private disposed = false;

  isConcurrencySafe(): boolean {
    return false;
  }

  parameters() {
    return CodeModeInputSchema;
  }

  schema(): ToolSchema {
    return createToolSchema(this.name, this.description, this.parameters());
  }

  async execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const parsed = CodeModeInputSchema.safeParse(args);
    if (!parsed.success) {
      return { output: parsed.error.message, isError: true };
    }
    if (!ctx.codeMode || !ctx.toolCallId) {
      return {
        output: "Code Mode requires an agent tool execution context.",
        isError: true,
      };
    }
    if (this.disposed) {
      return {
        output: "Code Mode host is closed.",
        isError: true,
        suspended: true,
      };
    }
    const execution = new CodeModeExecution();
    this.active.add(execution);
    let lease: SessionRunLeaseHandle | undefined;
    try {
      ctx.abortSignal?.throwIfAborted();
      if (ctx.codeMode.transcriptPath) {
        const target = resolveSessionStorageTarget({
          cwd: ctx.cwd,
          sessionId: ctx.sessionId ?? ctx.codeMode.sessionId,
        });
        if (!target) {
          throw new Error("Code Mode requires the root session storage target");
        }
        lease = acquireSessionRunLease(target, "vm");
      }
      return await execution.execute(
        { ...ctx.codeMode, progress: ctx.onOutput },
        ctx.toolCallId,
        parsed.data,
        ctx.abortSignal,
      );
    } catch (error) {
      return { output: asErrorString(error), isError: true };
    } finally {
      try {
        lease?.release();
      } finally {
        this.active.delete(execution);
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.active].map((execution) => execution.close()));
  }
}
