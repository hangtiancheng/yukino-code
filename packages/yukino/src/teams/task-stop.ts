import { z } from "zod";

import type { TaskManager } from "@/subagent/task-manager.js";
import {
  buildBackgroundTaskNotFoundError,
  buildBackgroundTaskNotRunningMessage,
  buildBackgroundTaskStoppedMessage,
  buildTeammateNotRunningMessage,
  buildTeammateStoppedMessage,
  buildUnknownTeammateError,
  TASK_STOP_TARGET_REQUIRED_ERROR,
  TEAMMATE_STOP_LEADER_ONLY_ERROR,
} from "@/teams/constants.js";
import type { TeamManager } from "@/teams/index.js";
import {
  TASK_STOP_SUBAGENT_TASK_ID_DESCRIPTION,
  TASK_STOP_SUBAGENT_TOOL_DESCRIPTION,
  TASK_STOP_TASK_ID_DESCRIPTION,
  TASK_STOP_TEAMMATE_DESCRIPTION,
  TASK_STOP_TOOL_DESCRIPTION,
  TEAM_NAME_PARAM_DESCRIPTION,
} from "@/teams/prompts.js";
import { createToolSchema } from "@/tools/schema.js";
import type {
  Tool,
  ToolCategory,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@/tools/types.js";
import { asErrorString } from "@/utils/index.js";

/** Abort a running teammate or one-shot background Agent/Bash/PowerShell task. */
export class TaskStopTool implements Tool {
  name = "TaskStop";
  description = TASK_STOP_TOOL_DESCRIPTION;
  category: ToolCategory = "command";

  constructor(
    private teamManager: TeamManager,
    private taskManager?: TaskManager,
    private leaderAccess = true,
  ) {
    if (!leaderAccess) {
      this.category = "read";
      this.description = TASK_STOP_SUBAGENT_TOOL_DESCRIPTION;
    }
  }

  forSubagent(): TaskStopTool {
    return new TaskStopTool(this.teamManager, undefined, false);
  }

  parameters() {
    const task_id = z
      .string()
      .min(1)
      .describe(
        this.leaderAccess
          ? TASK_STOP_TASK_ID_DESCRIPTION
          : TASK_STOP_SUBAGENT_TASK_ID_DESCRIPTION,
      );
    return this.leaderAccess
      ? z.strictObject({
          task_id: task_id.optional(),
          teammate: z
            .string()
            .min(1)
            .describe(TASK_STOP_TEAMMATE_DESCRIPTION)
            .optional(),
          team_name: z
            .string()
            .describe(TEAM_NAME_PARAM_DESCRIPTION)
            .optional(),
        })
      : z.strictObject({ task_id });
  }
  schema(): ToolSchema {
    return createToolSchema(this.name, this.description, this.parameters());
  }

  async execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const validated = this.parameters().safeParse(args);
    if (!validated.success) {
      return { output: validated.error.message, isError: true };
    }
    args = validated.data;
    const name =
      "teammate" in validated.data ? (validated.data.teammate ?? "") : "";
    const taskId = validated.data.task_id ?? "";
    if ((!name && !taskId) || (name && taskId)) {
      return {
        output: TASK_STOP_TARGET_REQUIRED_ERROR,
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
          output: buildBackgroundTaskNotFoundError(taskId),
          isError: true,
        };
      }
      if (task.status !== "running") {
        await task.done;
        return {
          output: buildBackgroundTaskNotRunningMessage(taskId, task.status),
          isError: false,
        };
      }
      await manager?.stopAndWait(taskId);
      return {
        output: buildBackgroundTaskStoppedMessage(taskId),
        isError: false,
      };
    }

    if (!this.leaderAccess) {
      return { output: TEAMMATE_STOP_LEADER_ONLY_ERROR, isError: true };
    }

    try {
      const team = this.teamManager.resolveTeam(
        ("team_name" in validated.data
          ? (validated.data.team_name ?? "")
          : "") || undefined,
        name,
      );
      const member = team?.getMember(name);
      if (team && member) {
        if (!member.active) {
          return {
            output: buildTeammateNotRunningMessage(name, team.name),
            isError: false,
          };
        }
        await team.stopMember(name);
        return {
          output: buildTeammateStoppedMessage(name, team.name),
          isError: false,
        };
      }
    } catch (error) {
      return { output: asErrorString(error), isError: true };
    }

    return {
      output: buildUnknownTeammateError(name, this.knownMembers()),
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
