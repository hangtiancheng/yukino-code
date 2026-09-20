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

import { memo } from "react";

import { AgentToolProgress, type SubagentProgress } from "./agent-tool-progress.js";
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
  const merged = new Map(persistentAgentTools.map((tool) => [tool.toolId, tool]));
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
