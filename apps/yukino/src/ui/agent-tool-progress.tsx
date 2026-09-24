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

import { Box } from "ink";

import {
  ToolBlock,
  type ToolBlockInfo,
  type ToolCardStatus,
} from "./tool-display.js";

import type { AgentTask } from "@/subagent/task-manager.js";
import { formatTokens, type TeammateUIState } from "@/teams/progress.js";
import { strArg } from "@/utils/index.js";

export interface SubagentProgress {
  toolCallId: string;
  taskId?: string;
  role: string;
  turnCount: number;
  activeTools: { toolId: string; toolName: string }[];
  /**
   * Name of the most recently started tool. Unlike activeTools (which empties
   * the moment a tool finishes), this persists so the progress line keeps
   * showing the last tool until the next tool call replaces it.
   */
  lastTool?: string;
  status: "running" | "completed" | "failed" | "stopped";
  output?: string;
}

interface Props {
  tools: ToolBlockInfo[];
  subagents: SubagentProgress[];
  backgroundTasks: AgentTask[];
  teammates: TeammateUIState[];
  expanded: boolean;
}

function subagentProgress(subagent: SubagentProgress): string {
  const parts = [
    `${subagent.role} subagent`,
    `${String(subagent.turnCount)} turns`,
  ];
  const currentTool =
    subagent.activeTools.at(-1)?.toolName ?? subagent.lastTool;
  if (currentTool) {
    parts.push(currentTool);
  }
  return parts.join(" | ");
}

function teammateProgress(teammate: TeammateUIState): string {
  const parts = [`@${teammate.name}`];
  const currentTool =
    teammate.progress.activeTools.at(-1)?.toolName ??
    teammate.progress.lastActivity?.toolName;
  if (currentTool) {
    parts.push(currentTool);
  }
  parts.push(
    `${String(teammate.progress.turnCount)} turns`,
    `${formatTokens(teammate.progress.tokenCount)} tokens`,
  );
  return parts.join(" | ");
}

function teammateStatus(status: TeammateUIState["status"]): ToolCardStatus {
  return status === "idle" ? "completed" : status;
}

function backgroundTaskStatus(status: AgentTask["status"]): ToolCardStatus {
  return status === "cancelled" ? "stopped" : status;
}

function decorateTool(
  tool: ToolBlockInfo,
  subagents: Map<string, SubagentProgress>,
  backgroundTasks: Map<string, AgentTask>,
  teammates: Map<string, TeammateUIState>,
): ToolBlockInfo {
  if (tool.toolName === "Bash" || tool.toolName === "PowerShell") {
    // A running foreground command can be moved to the background with Ctrl+B
    // — but only while the background subsystem is on: the UI always wires a
    // task manager, so the env switch is the only runtime disable, and
    // advertising a no-op keypress would be misleading.
    const backgroundAvailable =
      process.env.YUKINO_DISABLE_BACKGROUND_TASKS !== "1";
    return tool.loading && !tool.progress && backgroundAvailable
      ? { ...tool, progress: "(Ctrl+B to run in background)" }
      : tool;
  }

  if (tool.toolName !== "Agent") {
    return tool;
  }

  const teammate = teammates.get(tool.toolId);
  if (teammate) {
    const status = teammateStatus(teammate.status);
    return {
      ...tool,
      progress: teammateProgress(teammate),
      status,
      loading: status === "running",
      isError: status === "failed" || status === "stopped",
    };
  }

  const subagent = subagents.get(tool.toolId);
  if (subagent) {
    return {
      ...tool,
      output: subagent.output ?? tool.output,
      progress: subagentProgress(subagent),
      status: subagent.status,
      loading: subagent.status === "running",
      isError: subagent.status === "failed" || subagent.status === "stopped",
    };
  }

  const backgroundTask = backgroundTasks.get(tool.toolId);
  if (backgroundTask) {
    const status = backgroundTaskStatus(backgroundTask.status);
    return {
      ...tool,
      output: backgroundTask.output || tool.output,
      progress: `${backgroundTask.name} subagent`,
      status,
      loading: status === "running",
      isError: status === "failed" || status === "stopped",
    };
  }

  const teamName = strArg(tool.args, "team_name");
  const background = tool.args.run_in_background === true;
  const role = strArg(tool.args, "subagent_type") || "general-purpose";
  return {
    ...tool,
    progress: teamName ? "0 turns | 0 tokens" : `${role} subagent | 0 turns`,
    ...(teamName || background ? { status: "running", loading: true } : {}),
  };
}

export function AgentToolProgress({
  tools,
  subagents,
  backgroundTasks,
  teammates,
  expanded,
}: Props) {
  const subagentsByTool = new Map(
    subagents.map((subagent) => [subagent.toolCallId, subagent]),
  );
  const backgroundTasksByTool = new Map(
    backgroundTasks.flatMap((task) =>
      task.originToolCallId ? [[task.originToolCallId, task]] : [],
    ),
  );
  const teammatesByTool = new Map(
    teammates.flatMap((teammate) =>
      teammate.originToolCallId ? [[teammate.originToolCallId, teammate]] : [],
    ),
  );

  return (
    <Box flexDirection="column">
      {tools.map((tool) => (
        <ToolBlock
          key={tool.toolId}
          tool={decorateTool(
            tool,
            subagentsByTool,
            backgroundTasksByTool,
            teammatesByTool,
          )}
          expanded={expanded}
        />
      ))}
    </Box>
  );
}
