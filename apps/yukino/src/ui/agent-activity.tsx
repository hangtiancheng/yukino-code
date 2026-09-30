import { memo } from "react";

import {
  AgentToolProgress,
  type SubagentProgress,
} from "./agent-tool-progress.js";
import type { ToolBlockInfo } from "./tool-display.js";

import type { AgentTask } from "@/subagent/task-manager.js";
import type { TeammateUIState } from "@/teams/progress.js";

export type { SubagentProgress } from "./agent-tool-progress.js";

interface Props {
  tools: ToolBlockInfo[];
  persistentAgentTools: ToolBlockInfo[];
  subagents: SubagentProgress[];
  backgroundTasks: AgentTask[];
  teammates: TeammateUIState[];
  isAsking: boolean;
  expanded: boolean;
}

export const AgentActivity = memo(function AgentActivity({
  tools,
  persistentAgentTools,
  subagents,
  backgroundTasks,
  teammates,
  isAsking,
  expanded,
}: Props) {
  const merged = new Map(
    persistentAgentTools.map((tool) => [tool.toolId, tool]),
  );
  for (const tool of tools) {
    merged.set(tool.toolId, tool);
  }

  return !isAsking && merged.size > 0 ? (
    <AgentToolProgress
      tools={[...merged.values()]}
      subagents={subagents}
      backgroundTasks={backgroundTasks}
      teammates={teammates}
      expanded={expanded}
    />
  ) : null;
});
