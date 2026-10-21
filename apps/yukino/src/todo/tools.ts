import z from "zod";

import type { TaskBoard, TaskList } from "@/todo/index.js";
import { taskProgress } from "@/todo/progress.js";
import { TODO_WRITE_DESCRIPTION } from "@/todo/prompts.js";
import { TodoWriteSchema } from "@/todo/write.js";
import type {
  Tool,
  ToolResult,
  ToolContext,
  ToolSchema,
} from "@/tools/types.js";
import { asErrorString } from "@/utils/index.js";

const TaskToolInputSchema = z.looseObject({
  type: z.literal("object"),
  properties: z.record(z.string(), z.looseObject({})),
  required: z.array(z.string()).optional(),
});

export class TodoWriteTool implements Tool {
  name = "TodoWrite";
  description = TODO_WRITE_DESCRIPTION;
  category = "read" as const;
  constructor(private list: TaskBoard) {}

  isConcurrencySafe(): boolean {
    return true;
  }

  schema(): ToolSchema {
    const { $schema: _schema, ...inputSchema } = z.toJSONSchema(
      TodoWriteSchema,
      { target: "draft-7", io: "input" },
    );
    return {
      name: this.name,
      description: this.description,
      input_schema: TaskToolInputSchema.parse(inputSchema),
    };
  }

  execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const parsed = TodoWriteSchema.safeParse(args);
    if (!parsed.success) {
      return Promise.resolve({ output: parsed.error.message, isError: true });
    }
    try {
      ctx.abortSignal?.throwIfAborted();
      const todos = this.list.write(parsed.data);
      return Promise.resolve({
        output: JSON.stringify(
          {
            boardId: this.list.boardId,
            todos,
            progress: taskProgress(todos).label,
          },
          null,
          2,
        ),
        isError: false,
      });
    } catch (error) {
      return Promise.resolve({
        output: `Error: ${asErrorString(error)}`,
        isError: true,
      });
    }
  }

  forList(list: TaskList): TodoWriteTool {
    return new TodoWriteTool(list);
  }
}
