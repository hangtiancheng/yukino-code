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

import type { TeamManager } from "./index.js";

import type {
  Tool,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@/tools/types.js";
import { strArg, strList } from "@/utils/index.js";

// Team shared task-board tools: TaskCreate / TaskGet / TaskList / TaskUpdate.
// All four tools operate on the same team's SharedTaskStore, so teammates share a single task list.

const VALID_STATUSES = new Set([
  "pending",
  "in_progress",
  "completed",
  "blocked",
]);

export class TeamTaskCreateTool implements Tool {
  name = "TaskCreate";
  description =
    "Create a shared task in the team's task board. Supports dependency tracking with blocks/blocked_by fields.";
  category = "command" as const;
  constructor(
    private mgr: TeamManager,
    private teamName: string,
    private agentName = "",
  ) {}
  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short task title" },
          description: { type: "string", description: "Optional task details" },
          assignee: {
            type: "string",
            description: "Teammate name to assign this task to",
          },
          blocks: {
            type: "array",
            items: { type: "string" },
            description: "IDs of tasks that this task blocks",
          },
          blocked_by: {
            type: "array",
            items: { type: "string" },
            description: "IDs of tasks that block this task",
          },
        },
        required: ["title"],
      },
    };
  }
  execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const title = strArg(args, "title");
    if (!title) {
      return Promise.resolve({
        output: "Error: 'title' is required",
        isError: true,
      });
    }
    const store = this.mgr.getTaskStore(this.teamName);
    if (!store) {
      return Promise.resolve({
        output: `Task store not found for team '${this.teamName}'`,
        isError: true,
      });
    }
    const task = store.create(
      title,
      strArg(args, "description"),
      strArg(args, "assignee"),
      strList(args.blocks),
      strList(args.blocked_by),
      this.agentName,
    );
    return Promise.resolve({
      output:
        `Task created:\n  ID: ${task.id}\n  Title: ${task.title}\n  Status: ${task.status}\n` +
        `  Assignee: ${task.assignee || "(unassigned)"}`,
      isError: false,
    });
  }
}

export class TeamTaskGetTool implements Tool {
  name = "TaskGet";
  description =
    "Get details of a shared task by ID, including dependency information.";
  category = "read" as const;
  constructor(
    private mgr: TeamManager,
    private teamName: string,
  ) {}
  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "ID of the task to fetch" },
        },
        required: ["task_id"],
      },
    };
  }
  execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const taskId = strArg(args, "task_id");
    if (!taskId) {
      return Promise.resolve({
        output: "Error: 'task_id' is required",
        isError: true,
      });
    }
    const store = this.mgr.getTaskStore(this.teamName);
    if (!store) {
      return Promise.resolve({
        output: `Task store not found for team '${this.teamName}'`,
        isError: true,
      });
    }
    const task = store.get(taskId);
    if (!task) {
      return Promise.resolve({
        output: `Task '${taskId}' not found`,
        isError: true,
      });
    }
    const lines = [
      `Task ${task.id}:`,
      `  Title:      ${task.title}`,
      `  Status:     ${task.status}`,
      `  Assignee:   ${task.assignee || "(unassigned)"}`,
      `  Created by: ${task.createdBy || "(unknown)"}`,
    ];
    if (task.description) {
      lines.push(`  Description: ${task.description}`);
    }
    if (task.blocks.length) {
      lines.push(`  Blocks:     ${task.blocks.join(", ")}`);
    }
    if (task.blockedBy.length) {
      lines.push(`  Blocked by: ${task.blockedBy.join(", ")}`);
    }
    return Promise.resolve({ output: lines.join("\n"), isError: false });
  }
}

export class TeamTaskListTool implements Tool {
  name = "TaskList";
  description =
    "List all shared tasks in the team's task board. Optionally filter by status (pending/in_progress/completed/blocked) or assignee.";
  category = "read" as const;
  constructor(
    private mgr: TeamManager,
    private teamName: string,
  ) {}
  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter by status" },
          assignee: { type: "string", description: "Filter by assignee name" },
        },
        required: [],
      },
    };
  }
  execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const store = this.mgr.getTaskStore(this.teamName);
    if (!store) {
      return Promise.resolve({
        output: `Task store not found for team '${this.teamName}'`,
        isError: true,
      });
    }
    const status = strArg(args, "status") || undefined;
    const assignee = strArg(args, "assignee") || undefined;
    const tasks = store.listTasks(status, assignee);
    if (tasks.length === 0) {
      const filters: string[] = [];
      if (status) {
        filters.push(`status=${status}`);
      }
      if (assignee) {
        filters.push(`assignee=${assignee}`);
      }
      const suffix = filters.length ? ` (filters: ${filters.join(", ")})` : "";
      return Promise.resolve({
        output: `No tasks found${suffix}`,
        isError: false,
      });
    }
    const icons: Record<string, string> = {
      pending: "○",
      in_progress: "◐",
      completed: "●",
      blocked: "✕",
    };
    const lines = [`Tasks (${String(tasks.length)}):`];
    for (const t of tasks) {
      const icon = icons[t.status] ?? "?";
      const assigneeStr = t.assignee ? ` [${t.assignee}]` : "";
      const deps = t.blockedBy.length
        ? ` (blocked by: ${t.blockedBy.join(", ")})`
        : "";
      lines.push(`  ${icon} [${t.id}] ${t.title}${assigneeStr}${deps}`);
    }
    return Promise.resolve({ output: lines.join("\n"), isError: false });
  }
}

export class TeamTaskUpdateTool implements Tool {
  name = "TaskUpdate";
  description =
    "Update a shared task's status, assignee, description, or dependencies. Use add_blocks/add_blocked_by to add dependency relations.";
  category = "command" as const;
  constructor(
    private mgr: TeamManager,
    private teamName: string,
  ) {}
  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "ID of the task to update" },
          status: {
            type: "string",
            description: "New status: pending/in_progress/completed/blocked",
          },
          assignee: { type: "string", description: "Teammate name to assign" },
          description: { type: "string", description: "New description" },
          add_blocks: {
            type: "array",
            items: { type: "string" },
            description: "Task IDs to add to the blocks list",
          },
          add_blocked_by: {
            type: "array",
            items: { type: "string" },
            description: "Task IDs to add to the blocked_by list",
          },
        },
        required: ["task_id"],
      },
    };
  }
  execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const taskId = strArg(args, "task_id");
    if (!taskId) {
      return Promise.resolve({
        output: "Error: 'task_id' is required",
        isError: true,
      });
    }
    const status = strArg(args, "status");
    if (status && !VALID_STATUSES.has(status)) {
      return Promise.resolve({
        output: `Invalid status '${status}'. Must be one of: blocked, completed, in_progress, pending`,
        isError: true,
      });
    }
    const store = this.mgr.getTaskStore(this.teamName);
    if (!store) {
      return Promise.resolve({
        output: `Task store not found for team '${this.teamName}'`,
        isError: true,
      });
    }

    const changes: string[] = [];
    const fields: {
      status?: string;
      assignee?: string;
      description?: string;
      addBlocks?: string[];
      addBlockedBy?: string[];
    } = {};
    if (status) {
      fields.status = status;
      changes.push(`status → ${status}`);
    }
    if (typeof args.assignee === "string") {
      fields.assignee = args.assignee;
      changes.push(`assignee → ${fields.assignee || "(unassigned)"}`);
    }
    if (typeof args.description === "string") {
      fields.description = args.description;
      changes.push("description updated");
    }
    const addBlocks = strList(args.add_blocks);
    if (addBlocks.length) {
      fields.addBlocks = addBlocks;
      changes.push(`blocks += ${addBlocks.join(", ")}`);
    }
    const addBlockedBy = strList(args.add_blocked_by);
    if (addBlockedBy.length) {
      fields.addBlockedBy = addBlockedBy;
      changes.push(`blocked_by += ${addBlockedBy.join(", ")}`);
    }

    const task = store.update(taskId, fields);
    if (!task) {
      return Promise.resolve({
        output: `Task '${taskId}' not found`,
        isError: true,
      });
    }
    return Promise.resolve({
      output: `Task ${task.id} updated: ${changes.length ? changes.join("; ") : "no changes"}`,
      isError: false,
    });
  }
}
