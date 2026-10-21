import z from "zod";

import { unresolvedTaskDependencies } from "@/todo/dependencies.js";
import type { TaskBoard, TaskList } from "@/todo/index.js";
import { taskProgress } from "@/todo/progress.js";
import {
  TASK_CREATE_DESCRIPTION,
  TASK_CREATE_METADATA_DESCRIPTION,
  TASK_FIELD_DESCRIPTIONS,
  TASK_GET_DESCRIPTION,
  TASK_LIST_DESCRIPTION,
  TASK_UPDATE_DESCRIPTION,
  TASK_UPDATE_METADATA_DESCRIPTION,
  TODO_WRITE_DESCRIPTION,
} from "@/todo/prompts.js";
import { StoredTaskSchema } from "@/todo/store.js";
import type {
  Tool,
  ToolResult,
  ToolContext,
  ToolSchema,
} from "@/tools/types.js";
import { asErrorString } from "@/utils/index.js";

const TaskCreateArgsSchema = z.strictObject({
  subject: StoredTaskSchema.shape.subject.describe(
    TASK_FIELD_DESCRIPTIONS.subject,
  ),
  description: StoredTaskSchema.shape.description.describe(
    TASK_FIELD_DESCRIPTIONS.description,
  ),
  metadata: StoredTaskSchema.shape.metadata
    .optional()
    .describe(TASK_CREATE_METADATA_DESCRIPTION),
});

const TaskGetArgsSchema = z.strictObject({
  taskId: StoredTaskSchema.shape.id.describe(TASK_FIELD_DESCRIPTIONS.taskId),
});

const TaskUpdateArgsSchema = z.strictObject({
  taskId: TaskGetArgsSchema.shape.taskId,
  status: StoredTaskSchema.shape.status
    .or(z.literal("deleted"))
    .optional()
    .describe(TASK_FIELD_DESCRIPTIONS.status),
  subject: TaskCreateArgsSchema.shape.subject.optional(),
  description: TaskCreateArgsSchema.shape.description.optional(),
  owner: StoredTaskSchema.shape.owner
    .optional()
    .describe(TASK_FIELD_DESCRIPTIONS.owner),
  priority: StoredTaskSchema.shape.priority.optional(),
  metadata: StoredTaskSchema.shape.metadata
    .optional()
    .describe(TASK_UPDATE_METADATA_DESCRIPTION),
  addBlocks: StoredTaskSchema.shape.blocks
    .optional()
    .describe(TASK_FIELD_DESCRIPTIONS.addBlocks),
  addBlockedBy: StoredTaskSchema.shape.blockedBy
    .optional()
    .describe(TASK_FIELD_DESCRIPTIONS.addBlockedBy),
});

const TodoWriteArgsSchema = z.strictObject({
  todos: z
    .array(
      z.strictObject({
        id: StoredTaskSchema.shape.id
          .optional()
          .describe(TASK_FIELD_DESCRIPTIONS.todoId),
        subject: TaskCreateArgsSchema.shape.subject,
        description: TaskCreateArgsSchema.shape.description.optional(),
        status: StoredTaskSchema.shape.status,
        priority: StoredTaskSchema.shape.priority,
      }),
    )
    .max(200),
});

const TaskToolInputSchema = z.looseObject({
  type: z.literal("object"),
  properties: z.record(z.string(), z.looseObject({})),
  required: z.array(z.string()).optional(),
});

function taskInputSchema(schema: z.ZodObject): ToolSchema["input_schema"] {
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(schema, {
    target: "draft-7",
    io: "input",
  });
  return TaskToolInputSchema.parse(inputSchema);
}

export class TaskCreateTool implements Tool {
  name = "TaskCreate";
  description = TASK_CREATE_DESCRIPTION;
  category = "read" as const;
  isConcurrencySafe(): boolean {
    return true;
  }

  private list: TaskBoard;

  constructor(list: TaskBoard) {
    this.list = list;
  }

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: taskInputSchema(TaskCreateArgsSchema),
    };
  }

  execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const parsed = TaskCreateArgsSchema.safeParse(args);
    if (!parsed.success) {
      return Promise.resolve({ output: parsed.error.message, isError: true });
    }
    const { subject, description, metadata } = parsed.data;
    try {
      ctx.abortSignal?.throwIfAborted();
      const task = this.list.create(subject, description, metadata);
      return Promise.resolve({
        output: `Task #${task.id} created successfully: ${task.subject}\n${taskProgress(this.list.list()).label}`,
        isError: false,
      });
    } catch (error) {
      return Promise.resolve({
        output: `Error: ${asErrorString(error)}`,
        isError: true,
      });
    }
  }

  forList(list: TaskList): TaskCreateTool {
    return new TaskCreateTool(list);
  }
}

export class TaskGetTool implements Tool {
  name = "TaskGet";
  description = TASK_GET_DESCRIPTION;
  category = "read" as const;

  private list: TaskBoard;

  constructor(list: TaskBoard) {
    this.list = list;
  }

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: taskInputSchema(TaskGetArgsSchema),
    };
  }

  execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const parsed = TaskGetArgsSchema.safeParse(args);
    if (!parsed.success) {
      return Promise.resolve({ output: parsed.error.message, isError: true });
    }
    let task;
    try {
      ctx.abortSignal?.throwIfAborted();
      task = this.list.get(parsed.data.taskId);
    } catch (error) {
      return Promise.resolve({
        output: `Error: ${asErrorString(error)}`,
        isError: true,
      });
    }
    if (!task) {
      return Promise.resolve({ output: "Task not found", isError: true });
    }
    return Promise.resolve({
      output: JSON.stringify(task, null, 2),
      isError: false,
    });
  }

  forList(list: TaskList): TaskGetTool {
    return new TaskGetTool(list);
  }
}

export class TaskListTool implements Tool {
  name = "TaskList";
  description = TASK_LIST_DESCRIPTION;
  category = "read" as const;

  private list: TaskBoard;

  constructor(list: TaskBoard) {
    this.list = list;
  }

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: { type: "object", properties: {} },
    };
  }

  execute(): Promise<ToolResult> {
    let tasks;
    try {
      tasks = this.list.list();
    } catch (error) {
      return Promise.resolve({
        output: `Error: ${asErrorString(error)}`,
        isError: true,
      });
    }
    if (tasks.length === 0) {
      return Promise.resolve({
        output: `No tasks found\n${taskProgress(tasks).label}`,
        isError: false,
      });
    }
    const lines = tasks.map((t) => {
      const blockers = unresolvedTaskDependencies(t, tasks);
      return `#${t.id}. [${t.status}] ${t.subject}${t.owner ? ` (${t.owner})` : ""}${blockers.length ? ` (blocked by: ${blockers.join(", ")})` : ""}`;
    });
    return Promise.resolve({
      output: [taskProgress(tasks).label, ...lines].join("\n"),
      isError: false,
    });
  }

  forList(list: TaskList): TaskListTool {
    return new TaskListTool(list);
  }
}

export class TaskUpdateTool implements Tool {
  name = "TaskUpdate";
  description = TASK_UPDATE_DESCRIPTION;
  category = "read" as const;
  isConcurrencySafe(): boolean {
    return true;
  }

  private list: TaskBoard;

  constructor(list: TaskBoard) {
    this.list = list;
  }

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: taskInputSchema(TaskUpdateArgsSchema),
    };
  }

  execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const result = TaskUpdateArgsSchema.safeParse(args);
    if (!result.success) {
      return Promise.resolve({
        output: asErrorString(result.error),
        isError: true,
      });
    }

    const { taskId, status, subject, description, ...updates } = result.data;

    try {
      ctx.abortSignal?.throwIfAborted();
      if (status === "deleted") {
        return Promise.resolve(
          this.list.delete(taskId)
            ? {
                output: `Task #${taskId} deleted\n${taskProgress(this.list.list()).label}`,
                isError: false,
              }
            : { output: "Task not found", isError: true },
        );
      }
      const task = this.list.update(taskId, {
        ...updates,
        ...(subject === undefined ? {} : { subject }),
        ...(description === undefined ? {} : { description }),
        ...(status ? { status } : {}),
      });
      return Promise.resolve(
        task
          ? {
              output: `Updated task #${taskId}: ${task.status}${task.owner ? ` (owner: ${task.owner})` : ""}.${status === "completed" ? " Call TaskList to find the next available task; verify the completed work before reporting success." : ""}\n${taskProgress(this.list.list()).label}`,
              isError: false,
            }
          : { output: "Task not found", isError: true },
      );
    } catch (error) {
      return Promise.resolve({
        output: `Error: ${asErrorString(error)}`,
        isError: true,
      });
    }
  }

  forList(list: TaskList): TaskUpdateTool {
    return new TaskUpdateTool(list);
  }
}

export class TodoWriteTool implements Tool {
  name = "TodoWrite";
  description = TODO_WRITE_DESCRIPTION;
  category = "read" as const;
  constructor(private list: TaskList) {}
  isConcurrencySafe(): boolean {
    return true;
  }
  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: taskInputSchema(TodoWriteArgsSchema),
    };
  }
  execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const parsed = TodoWriteArgsSchema.safeParse(args);
    if (!parsed.success) {
      return Promise.resolve({ output: parsed.error.message, isError: true });
    }
    try {
      ctx.abortSignal?.throwIfAborted();
      const todos = this.list.replace(parsed.data.todos);
      return Promise.resolve({
        output: JSON.stringify(
          { todos, progress: taskProgress(todos).label },
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

export function isLocalTaskTool(
  tool: Tool,
): tool is
  TaskCreateTool | TaskGetTool | TaskListTool | TaskUpdateTool | TodoWriteTool {
  return (
    tool instanceof TaskCreateTool ||
    tool instanceof TaskGetTool ||
    tool instanceof TaskListTool ||
    tool instanceof TaskUpdateTool ||
    tool instanceof TodoWriteTool
  );
}
