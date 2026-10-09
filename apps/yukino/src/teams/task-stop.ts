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
    private leaderAccess = true,
  ) {
    if (!leaderAccess) {
      this.category = "read";
      this.description =
        "Stop one of this agent's own background tasks (Agent, Bash, PowerShell). Pass task_id.";
    }
  }

  forSubagent(): TaskStopTool {
    return new TaskStopTool(this.teamManager, undefined, false);
  }

  schema(): ToolSchema {
    if (!this.leaderAccess) {
      return {
        name: this.name,
        description: this.description,
        input_schema: {
          type: "object",
          properties: {
            task_id: {
              type: "string",
              description: "ID of this agent's background task",
            },
          },
          required: ["task_id"],
          additionalProperties: false,
        },
      };
    }
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
      // A delegated loop must not cancel tasks belonging to its parent.
      const manager =
        ctx.taskManager !== undefined ? ctx.taskManager : this.taskManager;
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

    if (!this.leaderAccess) {
      return { output: "Only the leader can stop teammates.", isError: true };
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
