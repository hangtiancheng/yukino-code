import type { TaskBoard, TaskList } from "@/todo/index.js";
import { taskProgress } from "@/todo/progress.js";
import { TODO_WRITE_DESCRIPTION } from "@/todo/prompts.js";
import { TodoWriteSchema } from "@/todo/write.js";
import { createToolSchema } from "@/tools/schema.js";
import type {
  Tool,
  ToolResult,
  ToolContext,
  ToolSchema,
} from "@/tools/types.js";
import { asErrorString } from "@/utils/index.js";

export class TodoWriteTool implements Tool {
  name = "TodoWrite";
  description = TODO_WRITE_DESCRIPTION;
  category = "read" as const;
  constructor(private list: TaskBoard) {}

  isConcurrencySafe(): boolean {
    return true;
  }

  parameters() {
    return TodoWriteSchema;
  }

  schema(): ToolSchema {
    return createToolSchema(this.name, this.description, this.parameters());
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
