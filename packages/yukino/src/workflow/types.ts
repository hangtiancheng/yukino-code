export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: { title: string; detail?: string }[];
}

export interface AgentRunParams {
  prompt: string;

  schema?: object;
  model?: string;

  maxTokens?: number;

  agentType?: string;
  isolation?: "worktree";
  allowedTools?: string[];

  label?: string;

  phase?: string;
}

export interface AgentProgressUpdate {
  tokenCount: number;
  toolCount: number;
}

export type AgentRunResult =
  | {
      kind: "ok";
      output: unknown;
      usage: { outputTokens: number };

      model?: string;

      toolCount?: number;

      tokenCount?: number;
    }
  | { kind: "skipped" }
  | {
      kind: "dead";

      reason?:
        | "no-structured-output"
        | "invalid-structured-output"
        | "run-agent-threw"
        | "worktree-failed"
        | "unknown";

      detail?: string;
    };

export interface JournalEntry {
  key: string;

  seq: number;
  result: AgentRunResult;
}

export type ProgressEvent =
  | {
      type: "run_started";
      runId: string;
      workflowName: string;
      meta: WorkflowMeta | null;
    }
  | { type: "phase_started"; runId: string; phase: string }
  | { type: "phase_done"; runId: string; phase: string }
  | {
      type: "agent_started";
      runId: string;
      agentId: number;
      label?: string;
      phase?: string;
    }
  | {
      type: "agent_done";
      runId: string;
      agentId: number;
      label?: string;
      phase?: string;
      result: AgentRunResult;
    }
  | {
      type: "agent_progress";
      runId: string;
      agentId: number;
      label?: string;
      phase?: string;
      tokenCount: number;
      toolCount: number;
    }
  | { type: "log"; runId: string; message: string }
  | {
      type: "run_done";
      runId: string;
      status: "completed" | "failed" | "killed";
      returnValue?: unknown;
      error?: string;
    };

export interface WorkflowRunResult {
  status: "completed" | "failed" | "killed";
  returnValue?: unknown;
  error?: string;
}
