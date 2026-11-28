import type { AgentEvent } from "@/agent/events.js";
import type { AppConfigOverrides } from "@/config/index.js";
import type { AppConfig } from "@/config/index.js";
import type {
  ProviderConfig,
  ThinkingLevel,
} from "@/config/provider-config.js";
import type { Message } from "@/conversation/index.js";
import type { ExecutionLedger } from "@/cost/ledger.js";
import type { CostSummary } from "@/cost/types.js";
import type { InputEntry } from "@/history/index.js";
import type { LLMClient } from "@/llm/client.js";
import type { UsageInfo } from "@/llm/events.js";
import type { MCPServerConfig } from "@/mcp/config.js";
import type { MCPManager } from "@/mcp/manager.js";
import type { PermissionChecker, PermissionMode } from "@/permissions/index.js";
import type { ProjectTrustRequest, TrustDecision } from "@/project/types.js";
import type { RuntimeSubagentEvent } from "@/runtime/types.js";
import type { SessionManager } from "@/session/manager.js";
import type { SessionRestorationOptions } from "@/session/restoration.js";
import type { Asker } from "@/tools/ask-user.js";
import type { ToolRegistry } from "@/tools/registry.js";
import type { PermissionRequestHandler, Tool } from "@/tools/types.js";

export type {
  SessionCopyConfirmation,
  SessionRestorationOptions,
} from "@/session/restoration.js";

export interface ResumeSessionOptions extends SessionRestorationOptions {
  /** Source storage project; never an execution destination or approval. */
  cwd?: string;
}

export interface SessionImportOptions {
  /** Execution destination, never taken from imported records. Defaults to the current cwd. */
  cwd?: string;
  signal?: AbortSignal;
}
export type { SessionStreamOptions } from "@/session/stream.js";

export type QueueMode = "all" | "one-at-a-time";
export type Delivery = "reject" | "steer" | "followUp";
export type AbortScope = "foreground" | "background" | "queue" | "all";
export interface PromptInput {
  text: string;
  attachments?: Record<string, unknown>[];
}
export interface PromptOptions {
  delivery?: Delivery;
  signal?: AbortSignal;
}
export interface PromptResult {
  status: "completed" | "aborted" | "failed";
  stopReason: string;
  text: string;
  messages: Message[];
  usage: UsageInfo;
  cost?: CostSummary;
  runId: string;
  sessionId: string;
}
export interface QueueEntry {
  id: string;
  kind: "steer" | "followUp";
  text: string;
  attachments?: Record<string, unknown>[];
  state: "queued" | "submitted";
}
export interface QueueReceipt {
  id: string;
  completion: Promise<PromptResult>;
}
export type PlanApproval = (request: {
  plan: string;
  sessionId: string;
  signal?: AbortSignal;
}) => Promise<"approve" | "deny" | { feedback: string }>;
export interface CreateAgentSessionOptions {
  configPath?: string;
  inputSource?: InputEntry["source"];
  client?: LLMClient;
  provider?: ProviderConfig;
  model?: string;
  cwd?: string;
  systemPrompt?: string;
  thinking?: ThinkingLevel;
  tools?: readonly Tool[] | readonly string[];
  exclude?: readonly string[];
  registry?: ToolRegistry;
  permissions?: PermissionMode | PermissionChecker;
  onPermissionRequest?: PermissionRequestHandler;
  onTrustRequest?: (request: ProjectTrustRequest) => Promise<TrustDecision>;
  trust?: TrustDecision;
  askUser?: Asker;
  planApproval?: PlanApproval;
  sessionManager?: SessionManager;
  persist?: boolean;
  trackFileChanges?: boolean;
  onBeforeFileEdit?: (path: string) => void;
  config?: Partial<AppConfig>;
  overrides?: AppConfigOverrides;
  disabled?: boolean;
  mcpServers?: MCPServerConfig[];
  mcpManager?: MCPManager;
  ledger?: ExecutionLedger;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  signal?: AbortSignal;
}

type AgentEvents = {
  [K in AgentEvent["type"]]: Omit<Extract<AgentEvent, { type: K }>, "type">;
};
export interface SessionEventPayloads extends AgentEvents {
  tool_output: { toolId: string; output: string };
  run_started: { input: PromptInput };
  run_settled: PromptResult;
  session_changed: { previousSessionId: string; cwd: string; input?: string };
  queue_changed: { entries: QueueEntry[] };
  task_changed: {
    tasks: {
      id: string;
      name: string;
      kind?: string;
      status: string;
      output: string;
    }[];
  };
  subagent: RuntimeSubagentEvent;
  disposed: Record<string, never>;
}
export type SessionEvent = {
  [K in keyof SessionEventPayloads]: {
    sequence: number;
    sessionId: string;
    runId: string | null;
    source: "session" | "agent" | "task" | "subagent";
    type: K;
    payload: SessionEventPayloads[K];
  };
}[keyof SessionEventPayloads];
export type SessionListener = (event: SessionEvent) => void | Promise<void>;
