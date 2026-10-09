import z from "zod";

import type { Tool, ToolContext, ToolResult, ToolSchema } from "./types.js";

import type { TaskManager } from "@/subagent/task-manager.js";
import { asErrorString } from "@/utils/index.js";

const Args = z
  .object({
    task_id: z.string().min(1),
    wait: z.boolean().default(false),
    timeout_ms: z.number().int().min(0).max(60_000).default(30_000),
  })
  .strict();

export class TaskOutputTool implements Tool {
  name = "TaskOutput";
  description =
    "Inspect a background Agent/Bash/PowerShell task by its task_id, or wait once for at most timeout_ms (maximum 60000). This does not consume completion notifications or cancel timed-out tasks. Prefer automatic task notifications over repeated polling. TaskCreate IDs belong to the separate TODO list and cannot be used here.";
  category = "read" as const;
  constructor(private manager?: TaskManager) {}
  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          wait: { type: "boolean", default: false },
          timeout_ms: {
            type: "integer",
            minimum: 0,
            maximum: 60_000,
            default: 30_000,
          },
        },
        required: ["task_id"],
        additionalProperties: false,
      },
    };
  }
  async execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const parsed = Args.safeParse(args);
    if (!parsed.success) {
      return { output: parsed.error.message, isError: true };
    }
    const { task_id: id, wait, timeout_ms: timeoutMs } = parsed.data;
    const manager =
      ctx.taskManager === null ? undefined : (ctx.taskManager ?? this.manager);
    try {
      ctx.abortSignal?.throwIfAborted();
      const result = wait
        ? await manager?.wait(id, { timeoutMs, abortSignal: ctx.abortSignal })
        : undefined;
      const task = result?.task ?? manager?.get(id);
      if (!task) {
        return {
          output: `Error: background task '${id}' not found in this agent's task registry`,
          isError: true,
        };
      }
      return {
        output: JSON.stringify(
          {
            task_id: task.id,
            name: task.name,
            kind: task.kind ?? "agent",
            status: task.status,
            timed_out: result?.timedOut ?? false,
            output: task.output,
          },
          null,
          2,
        ),
        isError: false,
      };
    } catch (error) {
      return { output: `Error: ${asErrorString(error)}`, isError: true };
    }
  }
  setTaskManager(manager: TaskManager): void {
    this.manager = manager;
  }
}
