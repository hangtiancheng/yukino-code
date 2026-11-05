import type { Goal, Teams, Todo, Workflow } from "@yukino.js/yukino";

export type RuntimeAction =
  | { type: "stop_task"; id: string }
  | { type: "stop_teammate"; team: string; name: string }
  | { type: "reload_skills" }
  | { type: "reload_mcp" }
  | { type: "pause_goal" }
  | { type: "clear_goal" }
  | { type: "sandbox"; mode: "auto" | "manual" | "off" };

export interface SubagentSnapshot {
  id: string;
  role: string;
  background: boolean;
  status: "running" | "completed" | "failed" | "stopped";
  tools: number;
  turns: number;
  activity: string;
}

export interface FileEntry {
  path: string;
  name: string;
  directory: boolean;
}

export interface FileSnapshot {
  path: string;
  content: string;
  baseline: string;
  revision: string;
  deleted: boolean;
}

export interface FileChange {
  path: string;
  status: string;
}

export interface WorkspaceSnapshot {
  cwd: string;
  changes: FileChange[];
  branch: string | null;
}

export interface RuntimeSnapshot {
  tools: string[];
  toolDescriptions: Record<string, string>;
  skills: { name: string; description: string }[];
  memories: {
    name: string;
    description: string;
    type: string;
    content: string;
  }[];
  mcpServers: string[];
  tasks: Todo.Task[];
  backgroundTasks: {
    id: string;
    name: string;
    kind: string;
    status: string;
    startedAt: number;
    output: string;
  }[];
  teammates: Teams.Progress.TeammateUIState[];
  subagents: SubagentSnapshot[];
  workflows: Workflow.Progress.WorkflowRun[];
  namedWorkflows: string[];
  goal: Goal.GoalState | null;
  sandbox: { enabled: boolean; autoAllow: boolean };
  coordinator: boolean;
  hooks: boolean;
  memoryEnabled: boolean;
  activeSkills: string[];
  checkpoints: { id: string; text: string; timestamp: string; files: number }[];
  permissionMode: string;
}
