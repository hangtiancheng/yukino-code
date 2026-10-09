import z from "zod";

import { unresolvedTaskDependencies } from "./dependencies.js";
import { taskProgress } from "./progress.js";
import { StoredTaskStatusSchema } from "./store.js";

import type { TaskBoard, TaskList } from "./index.js";

import type {
  Tool,
  ToolResult,
  ToolContext,
  ToolSchema,
} from "@/tools/types.js";
import { asErrorString, strArg } from "@/utils/index.js";

export class TaskCreateTool implements Tool {
  name = "TaskCreate";
  description =
    "Create a pending item on the current task board. This tracks work; it does not launch an Agent or a background task.";
  category = "read" as const;
  isConcurrencySafe(): boolean {
    return false;
  }

  private list: TaskBoard;

  constructor(list: TaskBoard) {
    this.list = list;
  }

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          subject: { type: "string", description: "Brief task title" },
          description: { type: "string", description: "What needs to be done" },
          activeForm: {
            type: "string",
            description: "Present continuous form for spinner",
          },
          metadata: {
            type: "object",
            description: "Task-specific structured context",
          },
        },
        required: ["subject", "description"],
        additionalProperties: false,
      },
    };
  }

  execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const parsed = z
      .object({
        subject: z.string().trim().min(1),
        description: z.string(),
        activeForm: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .safeParse(args);
    if (!parsed.success) {
      return Promise.resolve({ output: parsed.error.message, isError: true });
    }
    const { subject, description, activeForm, metadata } = parsed.data;
    try {
      ctx.abortSignal?.throwIfAborted();
      const task = this.list.create(subject, description, activeForm, metadata);
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
  description = "Get a task by its ID.";
  category = "read" as const;

  private list: TaskBoard;

  constructor(list: TaskBoard) {
    this.list = list;
  }

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: { taskId: { type: "string", description: "Task ID" } },
        required: ["taskId"],
      },
    };
  }

  execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const id = strArg(args, "taskId");
    let task;
    try {
      ctx.abortSignal?.throwIfAborted();
      task = this.list.get(id);
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
  description = "List all tasks.";
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
  description =
    "Atomically update the current task board's fields and dependencies. Dependency IDs must already exist; self-dependencies, cycles, and starting blocked work are rejected. Teammates claim in_progress tasks under their own name. deleted removes the task and its links.";
  category = "read" as const;
  isConcurrencySafe(): boolean {
    return false;
  }

  private list: TaskBoard;

  constructor(list: TaskBoard) {
    this.list = list;
  }

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID" },
          status: {
            type: "string",
            enum: [...StoredTaskStatusSchema.options, "deleted"],
            description:
              "New task status; deleted removes the item and its dependency links",
          },
          subject: { type: "string", description: "New subject" },
          description: { type: "string", description: "New description" },
          owner: { type: "string", description: "New owner" },
          activeForm: {
            type: "string",
            description: "Present continuous form for progress display",
          },
          priority: { type: "string", enum: ["high", "medium", "low"] },
          metadata: {
            type: "object",
            description:
              "Merge structured context; null deletes a metadata key",
          },
          addBlocks: {
            type: "array",
            items: { type: "string" },
            description: "Existing task IDs this one blocks",
          },
          addBlockedBy: {
            type: "array",
            items: { type: "string" },
            description: "Existing task IDs blocking this one",
          },
        },
        required: ["taskId"],
        additionalProperties: false,
      },
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

const TaskUpdateArgsSchema = z
  .object({
    taskId: z.string().trim().min(1),
    subject: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    status: z.enum([...StoredTaskStatusSchema.options, "deleted"]).optional(),
    owner: z.string().optional(),
    activeForm: z.string().optional(),
    priority: z.enum(["high", "medium", "low"]).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    addBlocks: z.array(z.string().trim().min(1)).optional(),
    addBlockedBy: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

export class TodoWriteTool implements Tool {
  name = "TodoWrite";
  description =
    "Replace this agent's entire private TODO list in one atomic update. Include all items to retain; reuse returned IDs to preserve metadata and dependency links. Returns todos with IDs and TODO completed/total progress. An empty array clears the list; completing all items retains them. Track complex work, not trivial requests; this tool never launches work.";
  category = "read" as const;
  constructor(private list: TaskList) {}
  isConcurrencySafe(): boolean {
    return false;
  }
  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            maxItems: 200,
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description: "Existing task ID; omit for a new item",
                },
                subject: { type: "string", description: "Brief task title" },
                description: { type: "string" },
                status: {
                  type: "string",
                  enum: StoredTaskStatusSchema.options,
                },
                activeForm: { type: "string" },
                priority: { type: "string", enum: ["high", "medium", "low"] },
              },
              required: ["subject", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["todos"],
        additionalProperties: false,
      },
    };
  }
  execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const parsed = z
      .object({
        todos: z
          .array(
            z
              .object({
                id: z.string().trim().min(1).optional(),
                subject: z.string().trim().min(1),
                description: z.string().optional(),
                status: StoredTaskStatusSchema,
                activeForm: z.string().optional(),
                priority: z.enum(["high", "medium", "low"]).optional(),
              })
              .strict(),
          )
          .max(200),
      })
      .strict()
      .safeParse(args);
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
