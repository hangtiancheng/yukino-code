import type { WorkbenchPage } from "@shared/workspace-types";
import {
  ActivityIcon,
  BotIcon,
  BoxesIcon,
  GitBranchIcon,
  HistoryIcon,
  LayersIcon,
  ListChecksIcon,
  PanelTopIcon,
  SparklesIcon,
  WorkflowIcon,
} from "lucide-react";

export const workbenchPages = [
  { id: "overview", label: "Overview", icon: PanelTopIcon },
  { id: "tasks", label: "Goals & tasks", icon: ListChecksIcon },
  { id: "agents", label: "Agents", icon: BotIcon },
  { id: "workflows", label: "Workflows", icon: WorkflowIcon },
  { id: "session", label: "Session & branches", icon: GitBranchIcon },
  { id: "controls", label: "Execution & usage", icon: ActivityIcon },
  { id: "mcp", label: "MCP servers", icon: BoxesIcon },
  { id: "capabilities", label: "Tools & skills", icon: SparklesIcon },
  { id: "context", label: "Context", icon: LayersIcon },
  { id: "history", label: "Checkpoints", icon: HistoryIcon },
] as const satisfies readonly {
  id: WorkbenchPage;
  label: string;
  icon: typeof ActivityIcon;
}[];
