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

import { safeParseAsync } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import z from "zod";

import type { StoredTaskStatus } from "./store.js";

import type { TaskList } from "./index.js";

import type {
  Tool,
  ToolResult,
  ToolContext,
  ToolSchema,
} from "@/tools/types.js";
import { asErrorString, strArg } from "@/utils/index.js";

export class TaskCreateTool implements Tool {
  name = "TaskCreate";
  description = "Create a new task to track work.";
  category = "read" as const;

  private list: TaskList;

  constructor(list: TaskList) {
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
        },
        required: ["subject", "description"],
      },
    };
  }

  execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const subject = strArg(args, "subject");
    const description = strArg(args, "description");
    const activeForm = strArg(args, "activeForm") || undefined;
    if (!subject) {
      return Promise.resolve({
        output: "Error: subject is required",
        isError: true,
      });
    }
    const task = this.list.create(subject, description, activeForm);
    return Promise.resolve({
      output: `Task #${task.id} created successfully: ${task.subject}`,
      isError: false,
    });
  }
}

export class TaskGetTool implements Tool {
  name = "TaskGet";
  description = "Get a task by its ID.";
  category = "read" as const;

  private list: TaskList;

  constructor(list: TaskList) {
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
    const task = this.list.get(id);
    if (!task) {
      return Promise.resolve({ output: "Task not found", isError: true });
    }
    return Promise.resolve({
      output: JSON.stringify(task, null, 2),
      isError: false,
    });
  }
}

export class TaskListTool implements Tool {
  name = "TaskList";
  description = "List all tasks.";
  category = "read" as const;

  private list: TaskList;

  constructor(list: TaskList) {
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
    const tasks = this.list.list();
    if (tasks.length === 0) {
      return Promise.resolve({ output: "No tasks found", isError: false });
    }
    const lines = tasks.map(
      (t) =>
        `#${t.id}. [${t.status}] ${t.subject}${t.owner ? ` (${t.owner})` : ""}`,
    );
    return Promise.resolve({ output: lines.join("\n"), isError: false });
  }
}

export class TaskUpdateTool implements Tool {
  name = "TaskUpdate";
  description = "Update a task's status, subject, or other fields.";
  category = "read" as const;

  private list: TaskList;

  constructor(list: TaskList) {
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
            description: "New status: pending, in_progress, completed, deleted",
          },
          subject: { type: "string", description: "New subject" },
          description: { type: "string", description: "New description" },
          owner: { type: "string", description: "New owner" },
          addBlocks: {
            type: "array",
            items: { type: "string" },
            description: "Tasks this one blocks",
          },
          addBlockedBy: {
            type: "array",
            items: { type: "string" },
            description: "Tasks blocking this one",
          },
        },
        required: ["taskId"],
      },
    };
  }

  async execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const result = await safeParseAsync(TaskUpdateArgsSchema, args);
    if (!result.success) {
      return {
        output: asErrorString(result.error),
        isError: true,
      };
    }

    const {
      taskId,
      status,
      subject,
      description,
      owner,
      addBlocks,
      addBlockedBy,
    } = result.data;

    if (!taskId) {
      return Promise.resolve({
        output: "Error: taskId is required",
        isError: true,
      });
    }

    if (status === "deleted") {
      this.list.delete(taskId);
      return Promise.resolve({
        output: `Task #${taskId} deleted`,
        isError: false,
      });
    }

    type Updates = Omit<TaskUpdateArgs, "taskId" | "status"> & {
      status?: StoredTaskStatus;
    };

    const updates: Updates = {};

    if (status) {
      updates.status = status;
    }
    if (subject) {
      updates.subject = subject;
    }
    if (description) {
      updates.description = description;
    }
    if (owner) {
      updates.owner = owner;
    }
    const task = this.list.update(taskId, updates);
    if (!task) {
      return { output: "Task not found", isError: true };
    }
    if (addBlocks) {
      this.list.addBlocks(taskId, addBlocks);
    }
    if (addBlockedBy) {
      this.list.addBlockedBy(taskId, addBlockedBy);
    }

    return { output: `Updated task #${taskId} status`, isError: false };
  }
}

const TaskUpdateArgsSchema = z.object({
  taskId: z.string(),
  subject: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(["pending", "in_progress", "completed", "deleted"]).optional(),
  owner: z.string().optional(),
  addBlocks: z.array(z.string()).optional(),
  addBlockedBy: z.array(z.string()).optional(),
});

type TaskUpdateArgs = z.infer<typeof TaskUpdateArgsSchema>;
