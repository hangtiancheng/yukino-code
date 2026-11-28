import type { AgentEvent } from "@/agent/events.js";
import type { SteeringMessage } from "@/agent/index.js";
import type { RuntimeCacheController } from "@/cache/controller.js";
import type { CommandRegistry } from "@/commands/commands.js";
import type { RecoveryState } from "@/compact/recovery.js";
import type { HookConfig, SandboxYamlConfig } from "@/config/index.js";
import type {
  CodeModeConfig,
  RuntimePreferences,
} from "@/config/preferences.js";
import type {
  ProviderConfig,
  ThinkingLevel,
} from "@/config/provider-config.js";
import type { ConversationManager } from "@/conversation/index.js";
import type { ExecutionContext } from "@/cost/context.js";
import type { ExecutionLedger } from "@/cost/ledger.js";
import type { FileHistory } from "@/file-history/index.js";
import type { GoalManager } from "@/goal/index.js";
import type { InputEntry } from "@/history/index.js";
import type { HookEngine } from "@/hooks/index.js";
import type { LLMClient } from "@/llm/client.js";
import type { MCPServerConfig } from "@/mcp/config.js";
import type {
  MCPManager,
  MCPManagerOptions,
  MCPSource,
} from "@/mcp/manager.js";
import type { MemoryManager } from "@/memory/manager.js";
import type { PermissionChecker } from "@/permissions/index.js";
import type { PermissionMode } from "@/permissions/index.js";
import type { RuntimeStatus } from "@/runtime/status.js";
import type { SkillCatalog } from "@/skills/catalog.js";
import type { TaskManager } from "@/subagent/task-manager.js";
import type { TeamManager } from "@/teams/index.js";
import type { TaskList } from "@/todo/index.js";
import type { Asker } from "@/tools/ask-user.js";
import type { FileStateCache } from "@/tools/file-state-cache.js";
import type { ToolRegistry } from "@/tools/registry.js";
import type { PermissionRequestHandler, Tool } from "@/tools/types.js";

export interface RunCallbacks {
  recoveryOnly?: boolean;
  onPermissionRequest: PermissionRequestHandler;
  input?: InputEntry;
  userContent?: string | Record<string, unknown>[];
  queuedInputs?: {
    content: string | Record<string, unknown>[];
    input: InputEntry;
  }[];
}

export type RuntimeSubagentEvent = {
  toolCallId: string;
  role: string;
  background: boolean;
} & (
  | { type: "started" }
  | { type: "tool_use"; toolId: string; toolName: string }
  | { type: "tool_result"; toolId: string }
  | { type: "turn_complete" }
  | { type: "finished"; status: "completed" | "failed" | "stopped" }
);

export interface CreateRuntimeOptions {
  provider: ProviderConfig;
  cwd: string;
  client?: LLMClient;
  cacheGuard?: () => string | undefined;
  systemPrompt?: string;
  sessionId?: string;
  ledger?: ExecutionLedger;
  executionContext?: ExecutionContext;
  persist?: boolean;
  codeMode?: CodeModeConfig;
  preferences?: RuntimePreferences;
  skillPaths?: readonly string[];
  skillFileDigests?: ReadonlyMap<string, string>;
  additionalSkillPaths?: readonly string[];
  disabledSkills?: readonly string[];
  shellPath?: string;
  shellCommandPrefix?: string;
  enableModelPlanMode?: boolean;
  interactionMode?: "interactive" | "non-interactive";
  sandboxConfig?: SandboxYamlConfig;
  hooks?: HookConfig[];
  mcpServers?: MCPServerConfig[];
  mcpManager?: MCPManager;
  authorizeMcpSource?: MCPManagerOptions["authorizeProject"];
  cleanupArtifacts?: boolean;
  trackFileChanges?: boolean;
  onBeforeFileEdit?: (path: string) => void;
  registry?: ToolRegistry;
  tools?: readonly Tool[];
  toolNames?: readonly string[];
  exclude?: readonly string[];
  enableCoordinatorMode: boolean;
  memoryEnabled?: boolean;
  loadProjectResources?: boolean;
  askUser?: Asker;
  checker?: PermissionChecker;
  onSubagentEvent?: (event: RuntimeSubagentEvent) => void;
}

export interface AgentRuntime {
  preferences: RuntimePreferences;
  abortRetry(): boolean;
  readonly cache: RuntimeCacheController;
  setThinking(level: ThinkingLevel): ThinkingLevel;
  updateProvider(
    provider: ProviderConfig,
    client: LLMClient,
  ): Promise<LLMClient>;
  getStatus(): RuntimeStatus;
  goalManager?: GoalManager;
  planFilePath?: string;
  client: LLMClient;
  systemPrompt?: string;
  conv: ConversationManager;
  registry: ToolRegistry;
  sessionId: string;
  executionContext?: ExecutionContext;
  ownSubagentSession(sessionId: string): void;
  fileHistory: FileHistory;
  fileStateCache: FileStateCache;
  cmdRegistry: CommandRegistry;
  skillCatalog: SkillCatalog | null;
  activeSkills: Map<string, string>;
  toolFilter: ((name: string) => boolean) | null;
  mcpManager: MCPManager | null;
  mcpSource?: MCPSource;
  refreshMcpTools?: () => Promise<void>;
  mcpAnnounced: Set<string>;
  hookEngine: HookEngine | null;
  recoveryState: RecoveryState;
  teamManager: TeamManager;
  backgroundTaskManager: TaskManager;
  enableCoordinatorMode: boolean;
  memoryManager: MemoryManager;
  memoryEnabled: boolean;
  contextWindow: number;
  provider: ProviderConfig;
  cwd: string;
  checker: PermissionChecker;
  permissionMode: PermissionMode;
  taskList: TaskList;
  run(
    text: string | Record<string, unknown>[] | null,
    callbacks: RunCallbacks,
  ): AsyncGenerator<AgentEvent>;
  abort(): void;
  abortForeground(): void;
  steer(
    text: string,
    input?: InputEntry,
    content?: string | Record<string, unknown>[],
  ): boolean;
  removeSteering(inputId: string): boolean;
  takeSteeringLeftovers(): SteeringMessage[];
  clearConversation(): Promise<void>;
  stopMemoryTasks(): Promise<void>;
  dispose(): Promise<void>;
}
