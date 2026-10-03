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
  subagents: SubagentProgress[];
  backgroundTasks: AgentTask[];
  teammates: TeammateUIState[];
  isAsking: boolean;
  expanded: boolean;
}

export const AgentActivity = memo(function AgentActivity({
  tools,
  subagents,
  backgroundTasks,
  teammates,
  isAsking,
  expanded,
}: Props) {
  return !isAsking && tools.length > 0 ? (
    <AgentToolProgress
      tools={tools}
      subagents={subagents}
      backgroundTasks={backgroundTasks}
      teammates={teammates}
      expanded={expanded}
    />
  ) : null;
});
