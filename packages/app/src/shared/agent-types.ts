import type {
  AgentSession,
  MCPExposure,
  MCPServerConfig,
  PreferencesPatch,
  CostEntry,
  SessionMetadata,
  WorkflowInput,
} from "@yukino.js/yukino";

export type AgentPreferences = ReturnType<AgentSession["getSettings"]>;
export type QueuedMessage = Omit<
  ReturnType<AgentSession["getQueue"]>[number],
  "attachments"
> & { attachmentCount: number };
export type RequestAttempt = Pick<
  CostEntry,
  | "attempt"
  | "attemptId"
  | "purpose"
  | "startedAt"
  | "endedAt"
  | "outcome"
  | "usage"
  | "estimate"
  | "providerAmount"
> & { model: string };

export interface AgentState {
  sessionId: string;
  busy: boolean;
  metadata: SessionMetadata;
  entries: {
    id: string;
    parentId: string | null;
    role: string;
    text: string;
    label?: string;
    active: boolean;
  }[];
  queue: QueuedMessage[];
  queueModes: ReturnType<AgentSession["getQueueModes"]>;
  retry: ReturnType<AgentSession["getRetryState"]>;
  status: ReturnType<AgentSession["getStatus"]>;
  stats: ReturnType<AgentSession["getStats"]>;
  attempts: RequestAttempt[];
  codeMode: ReturnType<AgentSession["getCodeModeState"]>;
  mcp: ReturnType<AgentSession["getMCPState"]>;
  sources: ReturnType<AgentSession["getProjectSources"]>;
  preferences: AgentPreferences;
}

export type AgentControl =
  | { type: "reload" }
  | { type: "settings"; patch: PreferencesPatch; persist: boolean }
  | { type: "metadata"; metadata: SessionMetadata }
  | { type: "label"; entryId: string; label: string | null }
  | { type: "navigate"; entryId: string | null; summary?: boolean | string }
  | { type: "fork"; entryId: string }
  | { type: "clone" }
  | { type: "compact"; instructions?: string }
  | { type: "clear_queue"; kind?: "steer" | "followUp" }
  | {
      type: "queue_mode";
      kind: "steer" | "followUp";
      mode: "all" | "one-at-a-time";
    }
  | { type: "auto_retry"; enabled: boolean }
  | { type: "auto_compaction"; enabled: boolean }
  | { type: "abort_retry" }
  | { type: "abort"; scope: "foreground" | "background" | "queue" | "all" }
  | { type: "cycle_model"; direction: 1 | -1 }
  | { type: "cycle_thinking"; direction: 1 | -1 }
  | { type: "warming"; enabled: boolean }
  | { type: "stop_code" }
  | { type: "revoke_trust" }
  | { type: "mcp_register"; config: MCPServerConfig }
  | {
      type:
        | "mcp_connect"
        | "mcp_disconnect"
        | "mcp_remove"
        | "mcp_logout"
        | "mcp_login";
      server: string;
    }
  | { type: "mcp_reload"; server: string; config?: MCPServerConfig }
  | {
      type: "mcp_exposure";
      server: string;
      exposure: MCPExposure;
      rules?: MCPServerConfig["tool_exposure"];
    }
  | {
      type: "mcp_resources";
      server: string;
      templates?: boolean;
      cursor?: string;
    }
  | { type: "mcp_read"; server: string; uri: string }
  | { type: "workflow_run"; input: WorkflowInput }
  | { type: "workflow_stop"; id: string }
  | { type: "workflow_stop_agent"; id: string; agentId: number };
