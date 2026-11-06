import type { BridgeEvent, ProviderInput } from "../src/shared/ipc-types.ts";
import type { RuntimeAction } from "../src/shared/workspace-types.ts";

export interface TestGoal {
  objective: string;
  status: string;
  tokenBudget: number | null;
  tokensUsed: number;
  turnsExecuted: number;
  activeMs: number;
  blockedAttempts: number;
  lastBlockReason: string | null;
}

export interface TestTask {
  id: string;
  subject: string;
  status: string;
  description: string;
  blocks: string[];
  blockedBy: string[];
  metadata: Record<string, unknown>;
}

export interface TestBackgroundTask {
  id: string;
  name: string;
  kind: string;
  status: string;
  startedAt: number;
  output: string;
}

export interface TestTeammate {
  name: string;
  teamName: string;
  status: string;
  progress: {
    turnCount: number;
    toolUseCount: number;
    tokenCount: number;
    lastActivity?: { activityDescription: string };
  };
  lastMessage?: string;
}

export interface TestSubagent {
  id: string;
  role: string;
  background: boolean;
  status: string;
  tools: number;
  turns: number;
  activity?: string;
}

export interface TestWorkflow {
  runId: string;
  workflowName: string;
  description?: string;
  status: string;
  phases: { title: string; status: string }[];
  agents: {
    id: string;
    label?: string;
    tokenCount: number;
    toolCount: number;
    status: string;
  }[];
  logs: string[];
  error?: string;
}

export interface TestMemory {
  name: string;
  description: string;
  type: string;
  content: string;
}

export interface TestCheckpoint {
  id: string;
  text: string;
  timestamp: string;
  files: number;
}

export interface TestRuntime {
  tools: string[];
  toolDescriptions: Record<string, string>;
  skills: { name: string; description: string }[];
  memories: TestMemory[];
  mcpServers: string[];
  tasks: TestTask[];
  backgroundTasks: TestBackgroundTask[];
  teammates: TestTeammate[];
  subagents: TestSubagent[];
  workflows: TestWorkflow[];
  namedWorkflows: string[];
  goal: TestGoal | null;
  sandbox: { enabled: boolean; autoAllow: boolean };
  hooks: boolean;
  coordinator: boolean;
  memoryEnabled: boolean;
  activeSkills: string[];
  checkpoints: TestCheckpoint[];
  permissionMode: string;
}

declare global {
  interface Window {
    __emit: (event: BridgeEvent) => void;
    __changeFile: (text: string) => void;
    __saved: string[];
    __runtime: TestRuntime;
    __sent?: string;
    __action?: RuntimeAction;
    __command?: string;
    __provider?: ProviderInput;
    __permissionMode?: string;
    __rewind?: { id: string; mode: string };
    __permission?: { id: string; response: string };
    __answers?: Record<string, string>;
    __plan?: { id: string; choice: string; feedback?: string };
  }
}
