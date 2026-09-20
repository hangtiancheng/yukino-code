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

import type { TaskManager } from "@/subagent/task-manager.js";
import type {
  Tool,
  ToolCategory,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@/tools/types.js";
import { strArg } from "@/utils/index.js";

/** Abort a running teammate or one-shot background Agent/Bash/PowerShell task. */
export class TaskStopTool implements Tool {
  name = "TaskStop";
  description =
    "Stop a running teammate or background task (Agent, Bash, PowerShell). Pass exactly one of teammate or task_id.";
  category: ToolCategory = "command";

  constructor(
    private teamManager: TeamManager,
    private taskManager?: TaskManager,
  ) {}

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          teammate: {
            type: "string",
            description:
              "Name of the teammate to stop, exactly as it appears in the from= field of a task-notification",
          },
          task_id: {
            type: "string",
            description: "ID of a background task (Agent, Bash, PowerShell)",
          },
        },
      },
    };
  }

  async execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const name = strArg(args, "teammate", "");
    const taskId = strArg(args, "task_id", "");
    if ((!name && !taskId) || (name && taskId)) {
      return {
        output: "Error: pass exactly one of teammate or task_id",
        isError: true,
      };
    }

    if (taskId) {
      // The task registry of the loop running this call takes precedence: a
      // fork's background tasks live in its per-run manager, and task IDs are
      // per-manager counters, so the same ID in the constructor-injected
      // (host-level) manager may be a different task. Fall back to that
      // injected manager so a fork can still stop tasks it saw in its
      // pre-fork conversation snapshot.
      const manager = ctx.taskManager?.get(taskId)
        ? ctx.taskManager
        : this.taskManager;
      const task = manager?.get(taskId);
      if (!task) {
        return {
          output: `Error: background task '${taskId}' not found`,
          isError: true,
        };
      }
      if (task.status !== "running") {
        return {
          output: `Background task '${taskId}' is ${task.status}, nothing to stop`,
          isError: false,
        };
      }
      await manager?.stopAndWait(taskId);
      return { output: `Background task '${taskId}' stopped.`, isError: false };
    }

    // Teammate names may collide across teams; only stop within the team that actually has this member to avoid killing a namesake
    for (const team of this.teamManager.list()) {
      const member = team.members.get(name);
      if (!member) {
        continue;
      }

      if (!member.active) {
        return {
          output: `Teammate '${name}' in team '${team.name}' is not running, nothing to stop`,
          isError: false,
        };
      }
      await team.stopMember(name);
      return {
        output: `Teammate '${name}' in team '${team.name}' stopped.`,
        isError: false,
      };
    }

    return {
      output: `Error: teammate '${name}' not found. Known teammates: ${this.knownMembers()}`,
      isError: true,
    };
  }

  /** List all current teammate names for the model, so it doesn't keep retrying with a misremembered name */
  private knownMembers(): string {
    const names: string[] = [];
    for (const team of this.teamManager.list()) {
      for (const memberName of team.members.keys()) {
        names.push(memberName);
      }
    }
    return names.length > 0 ? names.join(", ") : "(none)";
  }
}
