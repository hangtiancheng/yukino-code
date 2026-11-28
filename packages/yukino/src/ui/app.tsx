import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { Box, Text, useApp } from "ink";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";

import type { InteractionSummary } from "@/bootstrap/interaction-summary.js";
import { resolveInvocationProvider } from "@/bootstrap/invocation.js";
import {
  buildComposedToolFilter,
  countMcpTools,
  createToolRegistry,
  wireSkillsToRegistry,
} from "@/bootstrap/tool-registry.js";
import type { InvocationOptions } from "@/cli.js";
import {
  resolve as resolveCommand,
  createDefaultRegistry as createCommandRegistry,
} from "@/commands/commands.js";
import { runSubagentCommand } from "@/commands/subagent.js";
import { CommandUsageTracker } from "@/commands/usage-tracker.js";
import { currentContextTokens, forceCompact } from "@/compact/compact.js";
import { RecoveryState } from "@/compact/recovery.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_THINKING_LEVEL,
} from "@/config/constants.js";
import { loadConfig } from "@/config/index.js";
import type { AppConfigOverrides } from "@/config/index.js";
import type {
  AppConfig,
  HookConfig,
  SandboxYamlConfig,
} from "@/config/index.js";
import type { CodeModeConfig } from "@/config/preferences.js";
import { mergePreferences } from "@/config/preferences.js";
import {
  RuntimePreferencesSchema,
  persistPreferences,
} from "@/config/preferences.js";
import type { ProviderConfig } from "@/config/provider-config.js";
import {
  getContextWindow,
  getMaxOutputTokens,
  getSupportedThinkingLevels,
} from "@/config/provider-config.js";
import {
  persistDefaultProvider,
  persistModel,
  persistThinkingLevel,
  saveProvider,
} from "@/config/provider-login.js";
import { expandAtRefsWithImages } from "@/conversation/at-expand.js";
import {
  ConversationManager,
  type UserBashResult,
} from "@/conversation/index.js";
import { executeUserBash } from "@/conversation/user-bash.js";
import type { FileHistory } from "@/file-history/index.js";
import type { Snapshot } from "@/file-history/index.js";
import type { GoalManager } from "@/goal/index.js";
import { handleGoalCommand } from "@/goal/index.js";
import * as historyMod from "@/history/index.js";
import type { HookEngine } from "@/hooks/index.js";
import type { LLMClient } from "@/llm/client.js";
import { createClient } from "@/llm/client.js";
import { discoverModels } from "@/llm/model-discovery.js";
import { createChildLogger } from "@/logger/index.js";
import { executeMCPCommand } from "@/mcp/commands.js";
import type { MCPServerConfig } from "@/mcp/config.js";
import {
  retractMcpInstructions,
  syncMcpInstructions as announceMcpInstructions,
} from "@/mcp/instructions.js";
import { MCPManagement } from "@/mcp/management.js";
import type { MCPManager } from "@/mcp/manager.js";
import { decideAndApply } from "@/mcp/strategy.js";
import { loadInstructions } from "@/memory/instructions.js";
import { MemoryManager } from "@/memory/manager.js";
import { PermissionChecker, type PermissionMode } from "@/permissions/index.js";
import { getOrCreatePlanPath, planExists } from "@/plan-file/index.js";
import type { AuthorizedProject } from "@/project/types.js";
import { buildSystemPrompt, detectEnvironment } from "@/prompt/builder.js";
import { buildPlanModeExitReminder } from "@/prompt/plan-mode.js";
import { buildPlanExecutionPrompt } from "@/prompt/prompts.js";
import {
  createRuntimeEnvironment,
  type RuntimeEnvironment,
} from "@/remote/runtime-environment.js";
import { applyRuntimePreferences } from "@/runtime/preferences.js";
import { reloadRuntimeResources } from "@/runtime/resources.js";
import { captureSessionRuntimeState } from "@/runtime/session-state.js";
import {
  controlRuntimeWarming,
  formatRuntimeStatus,
} from "@/runtime/status.js";
import type { AgentRuntime } from "@/runtime/types.js";
import { createSandbox, type Sandbox } from "@/sandbox/index.js";
import {
  navigateSessionTree,
  parseSessionTreeCommand,
  updateSessionTreeOptions,
  type SessionTreeOptions,
  requestProjectTrust,
  sessionTransferCommand,
} from "@/session/actions.js";
import * as sessionMod from "@/session/index.js";
import { sessionMaintenanceCommand } from "@/session/maintenance-command.js";
import { SessionManager } from "@/session/manager.js";
import {
  parseSessionResumeCommand,
  requestSessionRestoration,
} from "@/session/resume.js";
import type { SkillCatalog } from "@/skills/catalog.js";
import { runFork as runSkillFork } from "@/skills/executor.js";
import type { SkillHost, SkillForkHost } from "@/skills/index.js";
import {
  PLAN_AGENT_NAME,
  SUBAGENT_INTERRUPTED_MARKER,
} from "@/subagent/constants.js";
import { spawnSubagent } from "@/subagent/spawn.js";
import { TaskManager, type AgentTask } from "@/subagent/task-manager.js";
import { LEADER_NAME } from "@/teams/constants.js";
import { coordinatorToolFilter } from "@/teams/coordinator.js";
import { TeamManager } from "@/teams/index.js";
import { shutdownRequest } from "@/teams/protocol.js";
import { TaskList } from "@/todo/index.js";
import { TaskStore } from "@/todo/store.js";
import { toDisplayPreview } from "@/tool-result/index.js";
import type { Question, Asker } from "@/tools/ask-user.js";
import { BashTool } from "@/tools/bash.js";
import { FileStateCache } from "@/tools/file-state-cache.js";
import {
  backgroundAllForegroundTasks,
  hasAnyForegroundTasks,
} from "@/tools/shell-background.js";
import type { PermissionRequestHandler } from "@/tools/types.js";
import { AgentActivity } from "@/ui/agent-activity.js";
import { AgentStatus } from "@/ui/agent-status.js";
import { ChatView, type ChatMessage, type ToolSummaryItem } from "@/ui/chat.js";
import { CLIENT_NOT_READY, MAX_RECENT_TOOLS, THEME } from "@/ui/constants.js";
import { DisplayPreferencesContext } from "@/ui/display-preferences.js";
import { Footer } from "@/ui/footer.js";
import { InteractionDock } from "@/ui/interaction-dock.js";
import {
  createInterruptHandlers,
  isForegroundBusy,
} from "@/ui/interrupt-scope.js";
import type { ModelPickerState } from "@/ui/model-select.js";
import { PendingQueue } from "@/ui/pending-queue.js";
import {
  createPermissionRequestHandler,
  type PermissionRequest,
} from "@/ui/permission-request.js";
import type { PlanChoice } from "@/ui/plan-approval.js";
import { ProviderLogin } from "@/ui/provider-login.js";
import { ProviderSelect } from "@/ui/provider-select.js";
import type { RewindAction } from "@/ui/rewind-dialog.js";
import { getThemeMode, setThemeMode } from "@/ui/styles.js";
import { activityStatusColor, thinkingLevelColor } from "@/ui/styles.js";
import { TerminalLayout } from "@/ui/terminal-layout.js";
import { TodoProgress } from "@/ui/todo-progress.js";
import { ToolBlock } from "@/ui/tool-display.js";
import { Transcript } from "@/ui/transcript.js";
import { UpdateNotice } from "@/ui/update-notice.js";
import { useAgentOutput } from "@/ui/use-agent-output.js";
import { useFollowUpQueue } from "@/ui/use-follow-up-queue.js";
import { useIdeInput } from "@/ui/use-ide-input.js";
import { useNotificationWakeup } from "@/ui/use-notification-wakeup.js";
import { useSubagents } from "@/ui/use-subagents.js";
import { useTaskProgress } from "@/ui/use-task-progress.js";
import { useTeammateStates } from "@/ui/use-teammate-states.js";
import { useTerminalControls } from "@/ui/use-terminal-controls.js";
import { useThemeMode } from "@/ui/use-theme-mode.js";
import { useUpdateNotice } from "@/ui/use-update-notice.js";
import {
  useUserBash,
  useUserBashHistory,
  userBashCard,
} from "@/ui/use-user-bash.js";
import {
  asErrorString,
  asRecord,
  contentToText,
  formatToolArgs,
  strArg,
} from "@/utils/index.js";
import { canonicalPath } from "@/utils/paths.js";
import { getWorkflowService } from "@/workflow/wiring.js";

const log = createChildLogger({ module: "terminal" });

type AppState = "providerSelect" | "chat";
type InitializationState =
  "uninitialized" | "initializing" | "ready" | "failed";

interface Props {
  config?: AppConfig;
  resolveAutoTheme?: () => Promise<"dark" | "light">;
  subscribeAutoTheme?: (
    listener: (theme: "dark" | "light") => void,
  ) => () => void;
  providers: ProviderConfig[];
  permissionMode?: string;
  mcpServers: MCPServerConfig[];
  hooks: HookConfig[];
  sandboxConfig?: SandboxYamlConfig;
  enableCoordinatorMode?: boolean;
  codeMode?: CodeModeConfig;
  /** Auto memory pipeline switch from config.yaml (`enable_memory:`); defaults to true. */
  memoryEnabled?: boolean;
  resume?: true | string;
  onExitSummary?: (summary: InteractionSummary) => void;
  defaultProvider?: number;
  invocationOptions?: InvocationOptions;
}

export function App({
  config: initialConfig,
  resolveAutoTheme,
  subscribeAutoTheme,
  providers: initialProviders,
  permissionMode,
  mcpServers,
  hooks,
  sandboxConfig: sandboxYaml,
  enableCoordinatorMode,
  codeMode = { mode: "off", inline_budget: 12000 },
  memoryEnabled = true,
  resume,
  onExitSummary,
  defaultProvider = 0,
  invocationOptions = {},
}: Props) {
  useThemeMode();
  const [preferences, setPreferences] = useState(() =>
    RuntimePreferencesSchema.parse(initialConfig ?? { code_mode: codeMode }),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsOverridesRef = useRef<AppConfigOverrides>({});
  const detectedThemeRef = useRef(getThemeMode());
  useEffect(() => {
    if (preferences.theme !== "auto") {
      return;
    }
    return subscribeAutoTheme?.((theme) => {
      detectedThemeRef.current = theme;
      setThemeMode(theme);
    });
  }, [preferences.theme, subscribeAutoTheme]);
  const { exit } = useApp();
  const { latestVersionRef, noticeVersion, dismissNotice } = useUpdateNotice();
  const [providers, setProviders] = useState(initialProviders);
  const [loginActive, setLoginActive] = useState(initialProviders.length === 0);
  const rememberedProvider = initialProviders.length
    ? resolveInvocationProvider(
        initialProviders,
        defaultProvider,
        invocationOptions,
      )
    : undefined;
  const [appState, setAppState] = useState<AppState>(
    initialProviders.length === 0 ? "providerSelect" : "chat",
  );
  const [selectedProvider, setSelectedProvider] = useState<ProviderConfig>(
    rememberedProvider ??
      providers[0] ?? {
        name: "",
        protocol: "anthropic",
        base_url: "",
        model: "",
      },
  );
  const selectedProviderRef = useRef(selectedProvider);
  const modelDialogControllerRef = useRef<AbortController | null>(null);
  const [providerDialogActive, setProviderDialogActive] = useState(false);
  const [modelDialogActive, setModelDialogActive] = useState(false);
  const [modelDialogState, setModelDialogState] = useState<ModelPickerState>({
    status: "loading",
    models: [],
  });
  const [thinkingDialogActive, setThinkingDialogActive] = useState(false);
  const [providerSwitching, setProviderSwitching] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const output = useAgentOutput(setMessages);
  const {
    streamingText,
    streamingThinking,
    streamingTextRef,
    activeTools,
    inputTokens,
    outputTokens,
  } = output;
  const [isStreaming, setIsStreaming] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [mcpBusy, setMcpBusy] = useState(false);
  const mcpControllerRef = useRef<AbortController | null>(null);
  const mcpManagementRef = useRef<MCPManagement | null>(null);
  const [permMode, setPermMode] = useState<PermissionMode>(() => {
    const isInitialPermissionMode = (mode: string): mode is PermissionMode =>
      ["default", "acceptEdits", "plan", "bypassPermissions"].includes(mode);
    if (permissionMode && isInitialPermissionMode(permissionMode)) {
      return permissionMode;
    }
    return "default";
  });
  const [error, setError] = useState<string | null>(null);
  const [planApprovalActive, setPlanApprovalActive] = useState(false);
  // Recently invoked tool names, deduplicated and kept in call order. Passed to the
  // memory recall selector so it skips usage-guide memories for these tools, while
  // still surfacing pitfall and warning memories
  const recentToolsRef = useRef<string[]>([]);
  // Memory paths already injected this session; pre-filtered before recall to avoid
  // the same memory occupying a slot every turn
  const permModeRef = useRef(permMode);
  const [mcpInfo, setMcpInfo] = useState<{
    servers: string[];
    toolCount: number;
  } | null>(null);
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  // Bumped when workspace file facts change (file-write tool results, agent run
  // end); the @-mention completion cache in InputBox keys on it.
  const [fileFactsVersion, setFileFactsVersion] = useState(0);

  const [cwd, setCwd] = useState(() =>
    canonicalPath(invocationOptions.cwd ?? process.cwd()),
  );
  const checkerRef = useRef<PermissionChecker | null>(null);
  checkerRef.current ??= new PermissionChecker(cwd, permMode);
  const planOwner = () =>
    (checkerRef.current ??= new PermissionChecker(cwd, permMode));

  useEffect(() => {
    permModeRef.current = permMode;
    if (checkerRef.current) {
      checkerRef.current.mode = permMode;
    }
  }, [permMode]);

  useEffect(() => {
    const checker = checkerRef.current;
    if (!checker) {
      return;
    }
    return checker.subscribeMode(() => {
      const mode = checker.mode;
      permModeRef.current = mode;
      setPermMode(mode);
    });
  }, [checkerRef.current]);

  const clientRef = useRef<LLMClient | null>(null);
  const clientInitializationRef = useRef<Promise<void> | null>(null);
  const [initializationState, setInitializationState] =
    useState<InitializationState>("uninitialized");
  const initializationStateRef = useRef<InitializationState>("uninitialized");
  const initializationGenerationRef = useRef(0);
  const initializationControllerRef = useRef<AbortController | null>(null);
  const initializationProviderRef = useRef<ProviderConfig | null>(null);
  const invocationProviderConsumedRef = useRef(false);
  const authorizedProjectRef = useRef<AuthorizedProject | undefined>(undefined);
  // Resolved context window for the active provider: the configured
  // context_window value, or DEFAULT_CONTEXT_WINDOW when unset.
  const contextWindowRef = useRef(
    rememberedProvider
      ? getContextWindow(rememberedProvider)
      : providers[0]
        ? getContextWindow(providers[0])
        : DEFAULT_CONTEXT_WINDOW,
  );
  // Output ceiling for the active provider (PI's model.maxTokens equivalent).
  const maxOutputRef = useRef(
    rememberedProvider
      ? getMaxOutputTokens(rememberedProvider)
      : providers[0]
        ? getMaxOutputTokens(providers[0])
        : undefined,
  );
  const conversationRef = useRef(new ConversationManager());
  const sessionIdRef = useRef(sessionMod.newSessionId());
  const sessionManagerRef = useRef<SessionManager | null>(null);
  const environmentRef = useRef<RuntimeEnvironment | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const [treeOptions, setTreeOptions] = useState<SessionTreeOptions>({});
  const treeQueryRef = useRef("");
  const treeSummaryRef = useRef<string | undefined>(undefined);
  const currentGoal = (): GoalManager => {
    const goal = environmentRef.current?.runtime.goalManager;
    if (!goal) {
      throw new Error("Goals require a persistent initialized runtime");
    }
    return goal;
  };
  const interactionStatsRef = useRef({
    agentActiveMs: 0,
    failedToolCalls: 0,
    startedAt: Date.now(),
    successfulToolCalls: 0,
    toolTimeMs: 0,
  });
  const activeToolIdsRef = useRef(new Set<string>());
  const activeToolBatchStartedAtRef = useRef<number | null>(null);
  const teamManagerRef = useRef(
    new TeamManager(cwd, enableCoordinatorMode ?? false),
  );
  const taskListRef = useRef(new TaskList(new TaskStore(sessionIdRef.current)));
  const { tasks: todos, boardId } = useTaskProgress(
    taskListRef.current,
    teamManagerRef.current,
  );
  const [toolRegistry] = useState(() =>
    createToolRegistry(taskListRef.current, {
      codeMode,
      interactionMode: "interactive",
      teamManager: teamManagerRef.current,
    }),
  );
  const registryRef = useRef(toolRegistry);
  const cmdRegistryRef = useRef(
    (() => {
      const registry = createCommandRegistry();
      registry.register({
        name: "provider",
        type: "local_ui",
        description: "Switch the active provider",
        handler: () => "provider",
      });
      return registry;
    })(),
  );
  const usageTrackerRef = useRef(new CommandUsageTracker());
  const mcpManagerRef = useRef<MCPManager | null>(null);
  const hookEngineRef = useRef<HookEngine | null>(null);
  const skillCatalogRef = useRef<SkillCatalog | null>(null);
  // Skills already announced to the model. The first system-reminder of the
  // session carries the full list; afterwards only new skills are sent as a
  // delta to avoid wasting context on duplicates.
  const announcedSkillsRef = useRef<Set<string>>(new Set());
  // MCP servers whose instructions the conversation has already been told about.
  // Announcements are deltas — servers connect, disconnect and get reconfigured
  // while a session runs — and syncMcpInstructions clears this set when the
  // announcement marker is gone from history, then rebuilds it from the
  // currently connected servers as it re-announces.
  const announcedMcpServersRef = useRef<Set<string>>(new Set());

  const recoveryStateRef = useRef(new RecoveryState());
  const stopMemoryTasks = useCallback(async () => {
    await environmentRef.current?.runtime.stopMemoryTasks();
  }, []);
  const memManagerRef = useRef<InstanceType<typeof MemoryManager> | null>(null);
  const activeSkillsRef = useRef(new Map<string, string>());
  const toolFilterRef = useRef<((name: string) => boolean) | null>(null);
  const skillHostRef = useRef<SkillHost>({
    activateSkill: (name, body) => activeSkillsRef.current.set(name, body),
  });
  const [backgroundTaskManager] = useState(
    () => new TaskManager(sessionIdRef.current),
  );
  const backgroundTaskManagerRef = useRef(backgroundTaskManager);
  const fileHistoryRef = useRef<FileHistory | null>(null);
  // The agent instance of the in-flight run, if any. Steering targets it.
  const agentRef = useRef<AgentRuntime | null>(null);
  const fileStateCacheRef = useRef(new FileStateCache());
  const sandboxRef = useRef<Promise<Sandbox | null> | null>(null);
  const getSandbox = (): Promise<Sandbox | null> =>
    (sandboxRef.current ??= createSandbox());
  const disposeSandbox = async (): Promise<void> => {
    const pending = sandboxRef.current;
    sandboxRef.current = null;
    const bashTool = registryRef.current.getInstanceOf("Bash", BashTool);
    if (bashTool) {
      bashTool.sandbox = null;
      bashTool.sandboxRequired = false;
    }
    await (await pending)?.dispose?.();
  };
  const [sandboxEnabled, setSandboxEnabled] = useState(
    sandboxYaml?.enabled ?? false,
  );
  const [sandboxAutoAllow, setSandboxAutoAllow] = useState(
    sandboxYaml?.auto_allow ?? false,
  );
  const sandboxEnabledRef = useRef(sandboxYaml?.enabled ?? false);
  const sandboxAutoAllowRef = useRef(sandboxYaml?.auto_allow ?? false);
  const sandboxNetworkEnabled = sandboxYaml?.network_enabled ?? true;
  useEffect(() => {
    sandboxEnabledRef.current = sandboxEnabled;
  }, [sandboxEnabled]);
  useEffect(() => {
    sandboxAutoAllowRef.current = sandboxAutoAllow;
  }, [sandboxAutoAllow]);
  useEffect(
    () => () => {
      void disposeSandbox();
    },
    [],
  );
  const abortControllerRef = useRef<AbortController | null>(null);
  const exitingRef = useRef(false);
  useEffect(() => {
    exitingRef.current = false;
    return () => {
      exitingRef.current = true;
      initializationGenerationRef.current += 1;
      initializationControllerRef.current?.abort();
      mcpControllerRef.current?.abort();
      void stopMemoryTasks();
      const environment = environmentRef.current;
      if (environment) {
        void Promise.allSettled([
          environment.project.dispose(),
          environment.runtime.dispose(),
        ]);
      }
    };
  }, [stopMemoryTasks]);
  const configureBashSandbox = async (bashTool: BashTool): Promise<boolean> => {
    if (!sandboxEnabledRef.current) {
      bashTool.sandbox = null;
      bashTool.sandboxRequired = false;
      return false;
    }
    const sandbox = await getSandbox();
    bashTool.sandbox = sandbox;
    bashTool.sandboxRequired = true;
    bashTool.sandboxConfig = {
      allowWrite: [cwd, "/tmp", tmpdir()],
      denyWrite: [],
      networkEnabled: sandboxNetworkEnabled,
    };
    return (await sandbox?.available()) ?? false;
  };
  const userBashHistory = useUserBashHistory({
    cwd,
    sessionId: sessionIdRef,
    conversation: conversationRef.current,
    busy: isStreaming || isCompacting,
    onError: (error) => {
      setMessages((messages) => [
        ...messages,
        {
          role: "system",
          content: `Error saving user Bash result: ${asErrorString(error)}`,
        },
      ]);
    },
  });
  const userBash = useUserBash({
    execute: async (command, signal, onOutput, excludeFromContext) => {
      const bashTool = registryRef.current.getInstanceOf("Bash", BashTool);
      if (!bashTool) {
        throw new Error("Bash tool is unavailable");
      }
      await configureBashSandbox(bashTool);
      return executeUserBash(
        bashTool,
        {
          cwd,
          sessionId: sessionIdRef.current,
          abortSignal: signal,
          onOutput,
        },
        command,
        excludeFromContext,
      );
    },
    setMessages,
    onStart: (text) => {
      dismissNotice();
      userBashInputRef.current = recordCliInput(text);
    },
    onSettled: () => {
      setFileFactsVersion((version) => version + 1);
    },
    onResult: (result) => {
      userBashHistory.record(result, userBashInputRef.current);
    },
  });
  const flushUserBashResults = userBashHistory.flush;
  const permissionResolveRef = useRef<
    ((v: "allow" | "deny" | "allowAlways") => void) | null
  >(null);
  // Permission asks from the main loop, subagents and teammates share the
  // single dialog slot; concurrent requests queue here and are presented in
  // order (or denied wholesale on interrupt).
  const permissionQueueRef = useRef<
    { present: () => void; deny: () => void }[]
  >([]);
  const [rewindDialogActive, setRewindDialogActive] = useState(false);
  const [rewindSnapshots, setRewindSnapshots] = useState<Snapshot[]>([]);
  const [transcriptRevision, setTranscriptRevision] = useState(0);
  // Steering messages queued into the in-flight agent, mirrored for display.
  // Entries are removed when the agent reports them delivered.
  const [steeringPending, setSteeringPending] = useState<
    historyMod.InputEntry[]
  >([]);
  const userBashInputRef = useRef<historyMod.InputEntry | undefined>(undefined);
  // Populated after useFollowUpQueue runs; lets the earlier-defined session
  // switch handlers (clear/resume/rewind) drop queued follow-ups when the
  // conversation baseline changes.
  const followUpResetRef = useRef<() => void>(() => undefined);
  const [resumeSessions, setResumeSessions] = useState<
    sessionMod.ProjectSessionInfo[]
  >([]);
  const [resumePickerOptions, setResumePickerOptions] = useState({
    allProjects: false,
    includeArchived: false,
    query: "",
  });
  const [resumeDialogActive, setResumeDialogActive] = useState(false);
  const initialResumeHandledRef = useRef(false);
  const [permissionRequest, setPermissionRequest] =
    useState<PermissionRequest | null>(null);
  const [askRequest, setAskRequest] = useState<Question[] | null>(null);
  const [askRequestId, setAskRequestId] = useState(0);
  const nextAskId = useRef(0);
  // AskUserQuestion is a read-category tool, so several can be in flight at
  // once. Each keeps its own resolver in a FIFO queue and the TUI presents them
  // one at a time; a single resolver slot would let a second call overwrite the
  // first and strand its promise.
  const askQueueRef = useRef<
    {
      id: number;
      questions: Question[];
      resolve: (a: Record<string, string>) => void;
    }[]
  >([]);
  const settleAskQueue = useCallback(() => {
    for (const pending of askQueueRef.current.splice(0)) {
      pending.resolve({});
    }
    setAskRequest(null);
  }, []);
  useEffect(
    () => () => {
      settleAskQueue();
    },
    [settleAskQueue],
  );
  const teammateStates = useTeammateStates(teamManagerRef.current);
  const [agentsDialogOpen, setAgentsDialogOpen] = useState(false);
  const [workflowsDialogOpen, setWorkflowsDialogOpen] = useState(false);
  const {
    subagents,
    cardsRef: subagentCardsRef,
    prepareTurn: prepareSubagentTurn,
    reset: resetSubagents,
    receive: receiveSubagentEvent,
  } = useSubagents(backgroundTaskManagerRef.current);
  const [backgroundTasks, setBackgroundTasks] = useState<AgentTask[]>([]);
  const runningBackgroundTasks = backgroundTasks.filter(
    (task) => task.status === "running",
  );
  const backgroundSubagents = runningBackgroundTasks.filter(
    (task) => task.kind !== "shell",
  );
  const backgroundShells =
    runningBackgroundTasks.length - backgroundSubagents.length;
  const { insertInputTextRef, clearInputRef } = useIdeInput(cwd);

  useEffect(
    () => backgroundTaskManagerRef.current.subscribe(setBackgroundTasks),
    [backgroundTaskManagerRef.current],
  );

  // Without a running user Bash command, Ctrl+C / Esc routes to interruptForeground,
  // which stops foreground execution — the in-flight agent loop (its
  // signal is shared by synchronous tool calls and run_in_background=false
  // subagents), a forked slash skill, /compact, or a subagent command. Background
  // tasks, background subagents and teammates own separate abort controllers and keep running;
  // only the TUI-exit path (double Ctrl+C, /quit) tears them down through
  // interruptAll().
  const { interruptForeground, interruptAll } = useMemo(
    () =>
      createInterruptHandlers({
        abortControllerRef,
        permissionResolveRef,
        setPermissionRequest,
        settleAskQueue,
        setPlanApprovalActive,
        permissionQueue: permissionQueueRef,
        backgroundTasks: backgroundTaskManagerRef.current,
        teams: teamManagerRef.current,
      }),
    [backgroundTaskManagerRef.current, teamManagerRef.current],
  );

  // Shared approval channel: the main agent loop, subagents and in-process
  // teammates all route "ask" decisions to the same modal dialog.
  const requestPermission = useMemo<PermissionRequestHandler>(
    () =>
      createPermissionRequestHandler({
        resolver: permissionResolveRef,
        queue: permissionQueueRef,
        present: setPermissionRequest,
      }),
    [],
  );

  const requestExit = useCallback(() => {
    exitingRef.current = true;
    initializationControllerRef.current?.abort();
    mcpControllerRef.current?.abort();
    const memoryStopped = stopMemoryTasks();
    void (async () => {
      interruptAll();
      await userBash.stop();
      // Join the fire-and-forget stopAlls and disconnect MCP before the app
      // unmounts (parity with print mode): on Windows the shell kills go
      // through async taskkill, and stdio MCP children need an explicit close.
      const cleanupResults = await Promise.allSettled([
        backgroundTaskManagerRef.current.stopAll(),
        teamManagerRef.current.dispose(),
        memoryStopped,
      ]);
      for (const result of cleanupResults) {
        if (result.status === "rejected") {
          log.error({ error: result.reason }, "terminal worker cleanup failed");
        }
      }
      await environmentRef.current?.project.dispose();
      await environmentRef.current?.runtime.dispose();
      const mcp = mcpManagerRef.current;
      if (mcp) {
        try {
          await mcp.disconnectAll();
        } catch {
          // best-effort — stdio children usually exit on stdin EOF anyway
        }
      }
      const activeToolTime = activeToolBatchStartedAtRef.current
        ? Date.now() - activeToolBatchStartedAtRef.current
        : 0;
      try {
        await registryRef.current.dispose();
      } catch (error) {
        log.error({ error }, "terminal tool cleanup failed");
      }
      flushUserBashResults(false);
      onExitSummary?.({
        ...interactionStatsRef.current,
        ...output.usageTotalsRef.current,
        latestVersion: latestVersionRef.current,
        sessionId: sessionIdRef.current,
        toolTimeMs: interactionStatsRef.current.toolTimeMs + activeToolTime,
      });
      exit();
    })();
  }, [
    exit,
    interruptAll,
    onExitSummary,
    userBash.stop,
    flushUserBashResults,
    latestVersionRef,
  ]);

  // Foreground-only work gate for Ctrl+C/Esc: while only background work is
  // running, a press must fall through to the press-twice-to-exit flow
  // instead of interrupting anything.
  const foregroundBusy =
    initializationState === "initializing" ||
    mcpBusy ||
    userBash.running ||
    isForegroundBusy(isStreaming, isCompacting, subagents);
  const interruptUserWork = () => {
    if (initializationStateRef.current === "initializing") {
      initializationControllerRef.current?.abort();
      return;
    }
    if (mcpBusy) {
      mcpControllerRef.current?.abort();
      return;
    }
    if (!userBash.interrupt()) {
      interruptForeground();
    }
  };
  // Single source of truth for "a modal dialog owns the keyboard": global
  // shortcuts belonging to the main chat input stand down while it is true, so
  // individual dialogs (AskUser Other, plan feedback, login, ...) do not each
  // need their own ad-hoc guard.
  const modalActive =
    settingsOpen ||
    loginActive ||
    providerDialogActive ||
    modelDialogActive ||
    thinkingDialogActive ||
    planApprovalActive ||
    treeOpen ||
    rewindDialogActive ||
    resumeDialogActive ||
    permissionRequest !== null ||
    askRequest !== null ||
    agentsDialogOpen ||
    workflowsDialogOpen;
  const { toolsExpanded, ctrlCHint } = useTerminalControls({
    defaultExpanded: preferences.display.expanded_tools,
    onExpandedChange: (expanded) => {
      const patch = { display: { expanded_tools: expanded } };
      const runtime = environmentRef.current?.runtime;
      if (runtime) {
        applyRuntimePreferences(runtime, patch);
      }
      settingsOverridesRef.current = mergePreferences(
        settingsOverridesRef.current,
        patch,
      );
      setPreferences((current) => ({
        ...current,
        display: { ...current.display, expanded_tools: expanded },
      }));
    },
    hasRunningWork: foregroundBusy,
    clearInputRef,
    onInterrupt: interruptUserWork,
    onExit: requestExit,
    modalActive,
    onBackgroundShells: () => {
      // Keep Ctrl+B inert when nothing is backgroundable. Modal ownership is
      // handled centrally via modalActive, not by special-casing dialogs here.
      if (!hasAnyForegroundTasks(registryRef.current)) {
        return;
      }
      backgroundAllForegroundTasks(registryRef.current);
    },
  });

  const activityStatus = error
    ? ("error" as const)
    : output.retryStatus
      ? ("retry" as const)
      : isCompacting || providerSwitching
        ? ("compacting" as const)
        : isStreaming || userBash.running || mcpBusy
          ? ("working" as const)
          : ("idle" as const);

  // Re-announces MCP instructions after a connect pass: servers that just came up
  // are announced, servers that went away are retracted, and an unchanged set
  // sends nothing at all.
  const syncMcpInstructions = useCallback((mgr: MCPManager) => {
    announceMcpInstructions(
      conversationRef.current,
      announcedMcpServersRef.current,
      mgr,
    );
  }, []);

  const askUser = useCallback<Asker>(
    (questions, signal) =>
      new Promise<Record<string, string>>((resolve) => {
        if (signal?.aborted || exitingRef.current) {
          resolve({});
          return;
        }
        const wasIdle = askQueueRef.current.length === 0;
        const id = ++nextAskId.current;
        const finish = (answers: Record<string, string>) => {
          signal?.removeEventListener("abort", cancel);
          resolve(answers);
        };
        const cancel = () => {
          const index = askQueueRef.current.findIndex(
            (request) => request.id === id,
          );
          if (index < 0) {
            return;
          }
          askQueueRef.current.splice(index, 1);
          finish({});
          if (index === 0) {
            const next = askQueueRef.current[0];
            if (next) {
              setAskRequestId(next.id);
            }
            setAskRequest(next?.questions ?? null);
          }
        };
        askQueueRef.current.push({ id, questions, resolve: finish });
        signal?.addEventListener("abort", cancel, { once: true });
        if (wasIdle) {
          setAskRequestId(id);
          setAskRequest(questions);
        }
      }),
    [],
  );

  const persistRuntimeState = useCallback(
    (environment = environmentRef.current) => {
      if (!environment) {
        return;
      }
      environment.manager.refresh();
      const state = captureSessionRuntimeState(
        environment.runtime,
        environment.project,
      );
      if (
        JSON.stringify(environment.manager.getRuntimeState()) !==
        JSON.stringify(state)
      ) {
        environment.manager.appendRuntimeState(state);
      }
    },
    [],
  );

  const initializeRuntime = useCallback(
    async (
      provider: ProviderConfig,
      manager?: SessionManager,
      global?: Partial<AppConfig>,
      generation = initializationGenerationRef.current,
      signal?: AbortSignal,
    ) => {
      if (
        exitingRef.current ||
        generation !== initializationGenerationRef.current
      ) {
        return;
      }
      mcpControllerRef.current?.abort();
      mcpManagementRef.current = null;
      const previous = environmentRef.current;
      let candidate: RuntimeEnvironment | undefined;
      let previousDisposed = false;
      try {
        const selectedManager =
          manager ??
          sessionManagerRef.current ??
          SessionManager.create(cwd, { persist: invocationOptions.persist });
        sessionManagerRef.current ??= selectedManager;
        const configuredProviders = global?.providers ?? providers;
        const selectedIndex = configuredProviders.findIndex(
          (entry) =>
            entry.name === provider.name &&
            entry.base_url === provider.base_url,
        );
        candidate = await createRuntimeEnvironment(
          {
            ...initialConfig,
            hooks,
            mcp_servers: mcpServers,
            sandbox: sandboxYaml,
            enable_coordinator_mode: enableCoordinatorMode,
            code_mode: codeMode,
            enable_memory: memoryEnabled,
            ...global,
            providers: configuredProviders,
            default_provider:
              selectedIndex >= 0
                ? selectedIndex
                : (global?.default_provider ?? defaultProvider),
          },
          selectedManager,
          {
            signal,
            authorizedProject: authorizedProjectRef.current,
            overrides: settingsOverridesRef.current,
            configSource: global ?? initialConfig,
            enableCoordinatorMode: enableCoordinatorMode ?? false,
            interactionMode: "interactive",
            enableModelPlanMode: true,
            invocationOptions: {
              ...invocationOptions,
              ...(invocationProviderConsumedRef.current
                ? {
                    provider: undefined,
                    model: undefined,
                    thinking: undefined,
                    trustProject: undefined,
                  }
                : {}),
            },
            checker:
              checkerRef.current ??
              new PermissionChecker(selectedManager.cwd, permModeRef.current),
            askUser,
            onTrustRequest: (request) => requestProjectTrust(askUser, request),
            onSubagentEvent: receiveSubagentEvent,
          },
        );
        const environment = candidate;
        if (
          exitingRef.current ||
          generation !== initializationGenerationRef.current
        ) {
          await Promise.allSettled([
            environment.project.dispose(),
            environment.runtime.dispose(),
          ]);
          return;
        }
        if (previous) {
          previousDisposed = true;
          const cleanup = await Promise.allSettled([
            previous.project.dispose(),
            previous.runtime.dispose(),
          ]);
          if (cleanup.some((result) => result.status === "rejected")) {
            throw new Error("Previous runtime cleanup failed");
          }
        }
        if (
          exitingRef.current ||
          generation !== initializationGenerationRef.current
        ) {
          await Promise.allSettled([
            environment.project.dispose(),
            environment.runtime.dispose(),
          ]);
          return;
        }
        environmentRef.current = environment;
        if (environment.project.trusted) {
          authorizedProjectRef.current = {
            identity: environment.project.identity,
            fingerprint: environment.project.fingerprint,
          };
        }
        if (sessionManagerRef.current?.id !== selectedManager.id) {
          setTreeOptions({});
          treeQueryRef.current = "";
        }
        sessionManagerRef.current = selectedManager;
        const runtime = environment.runtime;
        if (
          runtime.preferences.theme === "auto" &&
          initialConfig?.theme !== "auto" &&
          resolveAutoTheme
        ) {
          detectedThemeRef.current = await resolveAutoTheme();
        }
        setPreferences(structuredClone(runtime.preferences));
        setThemeMode(
          runtime.preferences.theme === "auto"
            ? detectedThemeRef.current
            : runtime.preferences.theme,
        );
        selectedProviderRef.current = runtime.provider;
        setSelectedProvider(runtime.provider);
        sessionIdRef.current = runtime.sessionId;
        setCwd(runtime.cwd);
        clientRef.current = runtime.client;
        registryRef.current = runtime.registry;
        conversationRef.current = runtime.conv;
        checkerRef.current = runtime.checker;
        taskListRef.current = runtime.taskList;
        teamManagerRef.current = runtime.teamManager;
        backgroundTaskManagerRef.current = runtime.backgroundTaskManager;
        cmdRegistryRef.current = runtime.cmdRegistry;
        mcpManagerRef.current = runtime.mcpManager;
        mcpManagementRef.current = new MCPManagement(
          runtime,
          environment.manager,
          requestPermission,
        );
        fileHistoryRef.current = runtime.fileHistory;
        fileStateCacheRef.current = runtime.fileStateCache;
        hookEngineRef.current = runtime.hookEngine;
        recoveryStateRef.current = runtime.recoveryState;
        skillCatalogRef.current = runtime.skillCatalog;
        activeSkillsRef.current = runtime.activeSkills;
        memManagerRef.current = runtime.memoryEnabled
          ? runtime.memoryManager
          : null;
        contextWindowRef.current = runtime.contextWindow;
        maxOutputRef.current = getMaxOutputTokens(runtime.provider);
        announcedSkillsRef.current.clear();
        announcedMcpServersRef.current.clear();
        setMcpInfo({
          servers: runtime.mcpManager?.connectedServers() ?? [],
          toolCount: countMcpTools(runtime.registry),
        });
        setPromptHistory(historyMod.loadInputTexts());
        if (environment.errors.length) {
          setMessages((previous) => [
            ...previous,
            {
              role: "system",
              content: `MCP errors: ${environment.errors.map((error) => `${error.serverName}: ${error.error}`).join("; ")}`,
            },
          ]);
        }
        if (environment.droppedDeclarations.length) {
          setMessages((previous) => [
            ...previous,
            {
              role: "system",
              content: `Unavailable historical tool declarations: ${environment.droppedDeclarations.join(", ")}`,
            },
          ]);
        }
        persistRuntimeState(environment);
        invocationProviderConsumedRef.current = true;
        initializationStateRef.current = "ready";
        setInitializationState("ready");
        setError(null);
      } catch (err) {
        if (candidate) {
          await Promise.allSettled([
            candidate.project.dispose(),
            candidate.runtime.dispose(),
          ]);
        }
        if (
          exitingRef.current ||
          generation !== initializationGenerationRef.current
        ) {
          return;
        }
        if (previous && !previousDisposed) {
          environmentRef.current = previous;
          clientRef.current = previous.runtime.client;
          selectedProviderRef.current = previous.runtime.provider;
          setSelectedProvider(previous.runtime.provider);
          initializationStateRef.current = "ready";
          setInitializationState("ready");
        } else {
          environmentRef.current = null;
          clientRef.current = null;
          initializationStateRef.current = "failed";
          setInitializationState("failed");
        }
        setError(`Failed to initialize agent: ${asErrorString(err)}`);
        throw err;
      }
    },
    [
      cwd,
      hooks,
      mcpServers,
      sandboxYaml,
      enableCoordinatorMode,
      codeMode,
      initialConfig,
      resolveAutoTheme,
      memoryEnabled,
      askUser,
      persistRuntimeState,
      providers,
      defaultProvider,
      requestPermission,
    ],
  );

  const initClient = useCallback(
    (
      provider: ProviderConfig,
      manager?: SessionManager,
      global?: Partial<AppConfig>,
    ) => {
      const generation = ++initializationGenerationRef.current;
      initializationControllerRef.current?.abort();
      const controller = new AbortController();
      initializationControllerRef.current = controller;
      initializationProviderRef.current = provider;
      initializationStateRef.current = "initializing";
      setInitializationState("initializing");
      const initialization = (
        clientInitializationRef.current?.catch(() => undefined) ??
        Promise.resolve()
      ).then(() =>
        initializeRuntime(
          provider,
          manager,
          global,
          generation,
          controller.signal,
        ),
      );
      clientInitializationRef.current = initialization;
      const settled = () => {
        if (clientInitializationRef.current === initialization) {
          clientInitializationRef.current = null;
        }
        if (initializationControllerRef.current === controller) {
          initializationControllerRef.current = null;
        }
      };
      void initialization.then(settled, settled);
      return initialization;
    },
    [initializeRuntime],
  );

  const reloadMcpServers = useCallback(async () => {
    const global = loadConfig(invocationOptions.config);
    const snapshot = environmentRef.current?.runtime.conv.getMessages() ?? [];
    const announced = new Set(environmentRef.current?.runtime.mcpAnnounced);
    await initClient(selectedProviderRef.current, undefined, global);
    if (environmentRef.current) {
      const runtime = environmentRef.current.runtime;
      runtime.conv.reset();
      runtime.conv.injectLongTermMemory(
        loadInstructions(runtime.cwd),
        runtime.memoryEnabled
          ? runtime.memoryManager.buildSystemReminder()
          : "",
      );
      const prefix = runtime.conv.getMessages()[0];
      const offset =
        prefix?.role === snapshot[0]?.role &&
        prefix?.content === snapshot[0]?.content
          ? 1
          : 0;
      runtime.conv.appendMessages(snapshot.slice(offset));
      runtime.mcpAnnounced = announced;
      announcedMcpServersRef.current = announced;
      retractMcpInstructions(runtime.conv, announced);
      if (runtime.mcpManager) {
        syncMcpInstructions(runtime.mcpManager);
      }
      setMessages((previous) => [
        ...previous,
        {
          role: "system",
          content: `MCP reloaded: ${String(mcpManagerRef.current?.connectedServers().length ?? 0)} server(s)`,
        },
      ]);
    }
  }, [initClient]);

  useEffect(() => {
    if (
      appState === "chat" &&
      !clientRef.current &&
      !clientInitializationRef.current &&
      !(
        initializationStateRef.current === "failed" &&
        initializationProviderRef.current === selectedProvider
      )
    ) {
      void initClient(selectedProvider).catch(() => undefined);
    }
  }, [appState, selectedProvider, initClient]);

  // Provider entry identity: reference equality first, then base_url+name for
  // re-parsed entries that are equal but not identical (see provider-login).
  const providerIndexOf = (
    provider: ProviderConfig,
    list: ProviderConfig[] = providers,
  ): number =>
    list.findIndex(
      (candidate) =>
        candidate === provider ||
        (candidate.base_url === provider.base_url &&
          candidate.name === provider.name),
    );

  const rememberProvider = (
    provider: ProviderConfig,
    list: ProviderConfig[] = providers,
  ): void => {
    try {
      persistDefaultProvider(Math.max(providerIndexOf(provider, list), 0));
    } catch {
      /* best effort */
    }
  };

  const handleProviderSelect = (
    provider: ProviderConfig,
    list?: ProviderConfig[],
  ) => {
    if (appState === "providerSelect" || !clientRef.current) {
      selectedProviderRef.current = provider;
      setSelectedProvider(provider);
      setAppState("chat");
      rememberProvider(provider, list);
      return;
    }

    setProviderDialogActive(false);
    setProviderSwitching(true);
    const previousProvider = selectedProviderRef.current;
    void (async () => {
      try {
        const environment = detectEnvironment(cwd, {
          skipGit: environmentRef.current?.project.trusted !== true,
        });
        environment.model = provider.model;
        const client = await createClient(
          provider,
          buildSystemPrompt(environment),
        );
        const runtime = environmentRef.current?.runtime;
        if (!runtime) {
          throw new Error("Agent is not initialized");
        }
        clientRef.current = await runtime.updateProvider(provider, client);
        selectedProviderRef.current = runtime.provider;
        setSelectedProvider(runtime.provider);
        rememberProvider(provider, list);
        persistRuntimeState();
        contextWindowRef.current = getContextWindow(runtime.provider);
        maxOutputRef.current = getMaxOutputTokens(provider);
        decideAndApply(
          registryRef.current,
          provider.base_url,
          provider.protocol,
        );
        setMessages((current) => [
          ...current,
          {
            role: "system",
            content: `Provider switched to ${provider.name} · ${provider.model}.`,
          },
        ]);
      } catch (err) {
        const runtime = environmentRef.current?.runtime;
        selectedProviderRef.current = runtime?.provider ?? previousProvider;
        setSelectedProvider(selectedProviderRef.current);
        if (runtime) {
          clientRef.current = runtime.client;
          contextWindowRef.current = runtime.contextWindow;
          maxOutputRef.current = getMaxOutputTokens(runtime.provider);
        }
        setError(`Failed to switch provider: ${asErrorString(err)}`);
      } finally {
        setProviderSwitching(false);
      }
    })();
  };

  /**
   * Switches the active model of the current provider — the only field /model
   * touches. The client is rebuilt so the change takes effect immediately, and
   * the endpoint's config entry is updated in place.
   */
  const applyModel = async (modelId: string): Promise<boolean> => {
    const provider = selectedProviderRef.current;
    const nextModel = modelId.trim();
    if (!nextModel || !clientRef.current) {
      return false;
    }
    if (nextModel === provider.model) {
      setMessages((current) => [
        ...current,
        { role: "system", content: `Model already set to ${nextModel}.` },
      ]);
      return true;
    }
    const updated = resolveInvocationProvider([provider], 0, {
      model: nextModel,
    });
    setProviderSwitching(true);
    try {
      const environment = detectEnvironment(cwd, {
        skipGit: environmentRef.current?.project.trusted !== true,
      });
      environment.model = updated.model;
      const client = await createClient(
        updated,
        buildSystemPrompt(environment),
      );
      const runtime = environmentRef.current?.runtime;
      if (!runtime) {
        throw new Error("Agent is not initialized");
      }
      clientRef.current = await runtime.updateProvider(updated, client);
      selectedProviderRef.current = runtime.provider;
      setSelectedProvider(runtime.provider);
      persistRuntimeState();
      setProviders((current) =>
        current.map((entry) =>
          entry.base_url === updated.base_url ? { ...updated } : entry,
        ),
      );
      contextWindowRef.current = getContextWindow(updated);
      maxOutputRef.current = getMaxOutputTokens(updated);
      decideAndApply(registryRef.current, updated.base_url, updated.protocol);
    } catch (err) {
      setError(`Failed to switch model: ${asErrorString(err)}`);
      return false;
    } finally {
      setProviderSwitching(false);
    }
    // A save failure must not undo the runtime switch.
    let saved = true;
    try {
      persistModel(updated.base_url, updated.model);
    } catch (err) {
      saved = false;
      setError(`Model switched but saving failed: ${asErrorString(err)}`);
    }
    setMessages((current) => [
      ...current,
      {
        role: "system",
        content: `Model set to ${updated.model}${saved ? " and saved" : " for this session"}.`,
      },
    ]);
    return true;
  };

  const closeModelPicker = (): void => {
    modelDialogControllerRef.current?.abort();
    modelDialogControllerRef.current = null;
    setModelDialogActive(false);
  };

  /** Lists the models the current provider advertises for the /model picker. */
  const openModelPicker = (): void => {
    modelDialogControllerRef.current?.abort();
    const controller = new AbortController();
    modelDialogControllerRef.current = controller;
    const provider = selectedProviderRef.current;
    setModelDialogState({ status: "loading", models: [] });
    setModelDialogActive(true);
    void discoverModels(
      {
        protocol: provider.protocol,
        base_url: provider.base_url,
        api_key: provider.api_key,
      },
      controller.signal,
    )
      .then((models) => {
        if (controller.signal.aborted) {
          return;
        }
        setModelDialogState({
          status: models.length > 0 ? "ready" : "empty",
          models,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setModelDialogState({ status: "error", models: [] });
        }
      });
  };

  /**
   * Maps restored/rebuilt conversation records onto visible transcript
   * messages. Tool chains are persisted as assistant records with tool_uses
   * and user records carrying only tool_results (empty text); mapping those
   * verbatim emits blank user-message boxes, so they fold into turn_summary
   * messages instead, mirroring how live turns are committed. Anything with
   * no visible text is skipped. Shared by /resume and /rewind so both leave
   * the transcript in sync with the rebuilt conversation.
   */
  const transcriptFromRestored = (
    restored: readonly {
      role: "user" | "assistant" | "system";
      content: string | Record<string, unknown>[];
      userBash?: UserBashResult;
      toolUses?: readonly {
        toolUseId: string;
        toolName: string;
        arguments?: Record<string, unknown> | null;
      }[];
      toolResults?: readonly {
        toolUseId: string;
        content: string;
        isError: boolean;
      }[];
    }[],
  ): ChatMessage[] => {
    const pendingUses = new Map<
      string,
      { toolName: string; argsSummary: string }
    >();
    const out: ChatMessage[] = [];
    for (const m of restored) {
      if (m.userBash) {
        out.push(userBashCard(m.userBash));
        continue;
      }
      for (const tu of m.toolUses ?? []) {
        pendingUses.set(tu.toolUseId, {
          toolName: tu.toolName,
          argsSummary: formatToolArgs(tu.arguments ?? {}),
        });
      }
      if (m.toolResults?.length) {
        const toolSummary: ToolSummaryItem[] = m.toolResults.map((tr) => {
          const use = pendingUses.get(tr.toolUseId);
          pendingUses.delete(tr.toolUseId);
          const toolName = use?.toolName ?? "tool";
          // Restored Agent cards get the same status semantics as live
          // ones: the interruption marker means the run was stopped, so
          // it must not render as a green success card.
          const agentStatus =
            toolName === "Agent" && !tr.isError
              ? tr.content.includes(SUBAGENT_INTERRUPTED_MARKER)
                ? "stopped"
                : "completed"
              : undefined;
          return {
            toolName,
            argsSummary: use?.argsSummary ?? "",
            output: toDisplayPreview(tr.content),
            isError: tr.isError,
            // No timing data in the session log; 0 hides the suffix.
            elapsed: 0,
            ...(agentStatus ? { status: agentStatus } : {}),
          };
        });
        out.push({ role: "turn_summary", content: "", toolSummary });
        continue;
      }
      const text = contentToText(m.content);
      if (text.trim()) {
        out.push({ role: m.role, content: text });
      }
    }
    return out;
  };

  const recordCliInput = (
    text: string,
    commandName: string | null = null,
  ): historyMod.InputEntry => {
    const input = historyMod.recordInput({
      text,
      commandName,
      cwd,
      sessionId: sessionIdRef.current,
      source: "cli",
    });
    setPromptHistory(historyMod.loadInputTexts());
    return input;
  };

  const runSlashCommand = async (
    text: string,
    submittedInput?: historyMod.InputEntry,
  ): Promise<boolean> => {
    const parsed = resolveCommand(text, cmdRegistryRef.current);
    if (!parsed) {
      return false;
    }

    if (
      [
        "tree",
        "fork",
        "clone",
        "name",
        "tags",
        "archive",
        "unarchive",
        "maintenance",
        "export",
        "import",
        "diagnostics",
      ].includes(parsed.name)
    ) {
      if (!submittedInput) {
        recordCliInput(text, parsed.name);
      }
      const runtime = environmentRef.current?.runtime;
      const manager = sessionManagerRef.current;
      if (!runtime || !manager) {
        setError(CLIENT_NOT_READY);
        return true;
      }
      try {
        if (parsed.name === "tree") {
          manager.refresh();
          const command = parseSessionTreeCommand(parsed.args);
          if (command.action === "label" && command.entryId) {
            manager.setLabel(command.entryId, command.text || null);
          } else if (command.action === "go" && command.entryId) {
            await navigateTree(command.entryId, command.summary);
          } else {
            setTreeOptions(
              updateSessionTreeOptions(manager.getTree(), treeOptions, command),
            );
            treeQueryRef.current = command.text;
            treeSummaryRef.current = command.summary;
            setTreeOpen(true);
          }
        } else if (
          parsed.name === "archive" ||
          parsed.name === "unarchive" ||
          parsed.name === "maintenance"
        ) {
          const message = await sessionMaintenanceCommand(
            parsed.name,
            parsed.args,
            manager,
            askUser,
          );
          setMessages((previous) => [
            ...previous,
            { role: "system", content: message },
          ]);
        } else {
          const result = await sessionTransferCommand(
            parsed.name,
            parsed.args,
            runtime,
            manager,
            askUser,
            requestPermission,
          );
          if (result.manager) {
            interruptAll();
            settleAskQueue();
            followUpResetRef.current();
            setPlanApprovalActive(false);
            await initClient(selectedProviderRef.current, result.manager);
            resetSubagents();
            setMessages(transcriptFromRestored(result.manager.getMessages()));
            if (result.manager.initialInput) {
              insertInputTextRef.current?.(result.manager.initialInput);
            }
          }
          setMessages((previous) => [
            ...previous,
            { role: "system", content: result.message },
          ]);
        }
      } catch (error) {
        setError(asErrorString(error));
      }
      return true;
    }

    if (parsed.name === "warming") {
      if (!submittedInput) {
        recordCliInput(text, "warming");
      }
      const runtime = environmentRef.current?.runtime;
      if (!runtime) {
        throw new Error("Agent is not initialized");
      }
      try {
        const message = await controlRuntimeWarming(runtime, parsed.args);
        setMessages((previous) => [
          ...previous,
          { role: "system", content: message },
        ]);
      } catch (error) {
        setError(asErrorString(error));
      }
      return true;
    }
    if (parsed.name === "mcp") {
      if (!submittedInput) {
        recordCliInput(text, "mcp");
      }
      if (parsed.args.trim().toLowerCase() === "reload") {
        await reloadMcpServers();
        return true;
      }
      const environment = environmentRef.current;
      const manager = environment?.runtime.mcpManager;
      const management = mcpManagementRef.current;
      if (!environment || !manager || !management) {
        throw new Error("Agent is not initialized");
      }
      const controller = new AbortController();
      mcpControllerRef.current = controller;
      setMcpBusy(true);
      try {
        const result = await executeMCPCommand(parsed.args, {
          management,
          manager,
          askUser,
          signal: controller.signal,
        });
        if (environment === environmentRef.current) {
          persistRuntimeState();
          setMcpInfo({
            servers: manager.connectedServers(),
            toolCount: countMcpTools(environment.runtime.registry),
          });
          setMessages((previous) => [
            ...previous,
            { role: "system", content: result.message },
          ]);
        }
      } catch (error) {
        if (environment === environmentRef.current) {
          setError(asErrorString(error));
        }
      } finally {
        if (mcpControllerRef.current === controller) {
          mcpControllerRef.current = null;
          setMcpBusy(false);
        }
      }
      return true;
    }

    const cmd = parsed.command;
    const input = submittedInput ?? recordCliInput(text, cmd?.name ?? null);
    if (!cmd) {
      setMessages((prev) => [
        ...prev,
        { role: "system", content: `Unknown command: /${parsed.name}` },
      ]);
      return true;
    }
    if (cmd.name === "goal") {
      const result = handleGoalCommand(currentGoal(), parsed.args);
      setMessages((prev) => [
        ...prev,
        { role: "system", content: result.message },
      ]);
      if (result.prompt && clientRef.current) {
        conversationRef.current.addUserMessage(result.prompt, input);
        sessionMod.saveUserMessage(cwd, sessionIdRef.current, input, {
          content: result.prompt,
        });
        setIsStreaming(true);
        output.prepareTurn();
        try {
          await runAgentLoopWithStats();
        } catch (error) {
          setError(asErrorString(error));
        } finally {
          setIsStreaming(false);
          output.clearTools();
        }
      }
      return true;
    }

    // Rich status/memory commands need live app state, so handle them here.
    if (cmd.name === "status") {
      const sandbox = sandboxEnabled ? await getSandbox() : null;
      const sandboxReady = sandbox ? await sandbox.available() : false;
      const sbStatus = sandboxEnabled
        ? `${sandboxAutoAllow ? "ON (auto-allow)" : "ON (manual)"}, ${sandboxReady ? "ready" : "blocked"}`
        : "OFF";
      const lines = [
        `Mode:      ${permMode}`,
        `Model:     ${selectedProvider.model}`,
        `Provider:  ${selectedProvider.name} (${selectedProvider.protocol})`,
        ...(environmentRef.current
          ? formatRuntimeStatus(
              environmentRef.current.runtime.getStatus(),
            ).split("\n")
          : []),
        `Tools:     ${String(registryRef.current.listTools().length)}`,
        `Sandbox:   ${sbStatus}`,
        `Memories:  ${
          memoryEnabled
            ? String(memManagerRef.current?.getMemories().length ?? 0)
            : "disabled (enable_memory: false)"
        }`,
        `Skills:    ${String(skillCatalogRef.current?.list().length ?? 0)}`,
        `MCP:       ${String(mcpInfo?.servers.length ?? 0)} server(s), ${String(mcpInfo?.toolCount ?? 0)} tool(s)`,
        `Session:   ${sessionIdRef.current}`,
        `Directory: ${cwd}`,
      ];
      setMessages((prev) => [
        ...prev,
        { role: "system", content: lines.join("\n") },
      ]);
      return true;
    }
    if (cmd.name === "memory") {
      if (!memoryEnabled) {
        setMessages((prev) => [
          ...prev,
          {
            role: "system",
            content:
              "Auto memory is disabled (enable_memory: false in config.yaml).",
          },
        ]);
        return true;
      }
      const sub = parsed.args.trim().split(/\s+/)[0];
      const mgr = new MemoryManager(cwd);
      if (sub === "clear") {
        mgr.clear();
        setMessages((prev) => [
          ...prev,
          { role: "system", content: "All memories cleared." },
        ]);
      } else {
        const mems = mgr.getMemories();
        const body =
          mems.length === 0
            ? "No memories saved yet. They are auto-extracted; /memory clear wipes them."
            : `Memories (${String(mems.length)}):\n` +
              mems
                .map((m) => `  [${m.type}] ${m.name} — ${m.description}`)
                .join("\n");
        setMessages((prev) => [...prev, { role: "system", content: body }]);
      }
      return true;
    }

    if (cmd.type === "local_ui") {
      const action = cmd.handler({ cwd, args: parsed.args });
      switch (action) {
        case "retry": {
          const runtime = environmentRef.current?.runtime;
          if (!runtime) {
            break;
          }
          const action = parsed.args.trim() || "status";
          const aborted = action === "abort" && runtime.abortRetry();
          if (action === "on" || action === "off") {
            applyRuntimePreferences(runtime, { auto_retry: action === "on" });
            settingsOverridesRef.current.auto_retry = action === "on";
            setPreferences(structuredClone(runtime.preferences));
          } else if (action !== "status" && action !== "abort") {
            throw new Error("Usage: /retry [status|on|off|abort]");
          }
          setMessages((previous) => [
            ...previous,
            {
              role: "system",
              content: `Automatic retry: ${runtime.preferences.auto_retry ? "on" : "off"}${action === "abort" ? (aborted ? " · pending retry cancelled" : " · no retry pending") : ""}`,
            },
          ]);
          break;
        }
        case "settings":
          setSettingsOpen(true);
          break;
        case "reload": {
          const environment = environmentRef.current;
          if (!environment) {
            throw new Error("Agent is not initialized");
          }
          const result = await reloadRuntimeResources(
            environment,
            loadConfig(invocationOptions.config),
            {
              overrides: settingsOverridesRef.current,
              disabled: invocationOptions.noProjectResources,
              onTrustRequest: (request) =>
                requestProjectTrust(askUser, request),
            },
          );
          authorizedProjectRef.current = environment.project.trusted
            ? {
                identity: environment.project.identity,
                fingerprint: environment.project.fingerprint,
              }
            : undefined;
          hookEngineRef.current = environment.runtime.hookEngine;
          setMcpInfo({
            servers: environment.runtime.mcpManager?.connectedServers() ?? [],
            toolCount: countMcpTools(environment.runtime.registry),
          });
          if (
            environment.runtime.preferences.theme === "auto" &&
            resolveAutoTheme
          ) {
            detectedThemeRef.current = await resolveAutoTheme();
          }
          setPreferences(structuredClone(environment.runtime.preferences));
          setThemeMode(
            environment.runtime.preferences.theme === "auto"
              ? detectedThemeRef.current
              : environment.runtime.preferences.theme,
          );
          persistRuntimeState();
          setTranscriptRevision((value) => value + 1);
          setMessages((previous) => [
            ...previous,
            {
              role: "system",
              content: `Resources reloaded: ${result.skills} skills · ${result.commands} commands${result.errors.map((error) => `\n${error.serverName}: ${error.error}`).join("")}`,
            },
          ]);
          break;
        }
        case "workflows": {
          const service = getWorkflowService(registryRef.current);
          if (!service) {
            break;
          }
          if (parsed.args.trim()) {
            try {
              const output = await service.command(parsed.args, {
                cwd,
                permissionChecker: checkerRef.current ?? undefined,
                onPermissionRequest: requestPermission,
              });
              setMessages((previous) => [
                ...previous,
                { role: "system", content: output },
              ]);
            } catch (error) {
              setError(asErrorString(error));
            }
          } else {
            setWorkflowsDialogOpen(true);
          }
          break;
        }
        case "login": {
          setLoginActive(true);
          break;
        }
        case "model": {
          if (parsed.args.trim()) {
            await applyModel(parsed.args);
          } else if (clientRef.current) {
            openModelPicker();
          } else {
            setMessages((current) => [
              ...current,
              { role: "system", content: CLIENT_NOT_READY },
            ]);
          }
          break;
        }
        case "provider": {
          if (providers.length < 2) {
            setMessages((current) => [
              ...current,
              {
                role: "system",
                content: `Provider: ${selectedProvider.name} · ${selectedProvider.model}`,
              },
            ]);
          } else {
            setProviderDialogActive(true);
          }
          break;
        }
        case "clear": {
          interruptAll();
          settleAskQueue();
          followUpResetRef.current();
          setPlanApprovalActive(false);
          await initClient(
            selectedProviderRef.current,
            SessionManager.create(cwd, { persist: invocationOptions.persist }),
          );
          resetSubagents();
          setMessages([]);
          output.resetUsage();
          break;
        }
        case "quit":
          requestExit();
          break;
        case "compact":
          if (clientRef.current) {
            const controller = new AbortController();
            const client = clientRef.current;
            const protocol = client.protocol ?? "anthropic";
            const toolFilter = buildComposedToolFilter(
              coordinatorToolFilter(enableCoordinatorMode ?? false),
              toolFilterRef.current,
            );
            abortControllerRef.current = controller;
            setIsCompacting(true);
            await forceCompact(
              conversationRef.current,
              client,
              recoveryStateRef.current,
              registryRef.current.listVisibleToolNames(protocol, toolFilter),
              registryRef.current.getAllSchemas(protocol, toolFilter),
              sessionMod.getSessionFilePath(cwd, sessionIdRef.current),
              controller.signal,
              parsed.args,
            )
              .then((result) => {
                // Persist the boundary so the compacted state survives /resume.
                if (result.boundary) {
                  sessionMod.saveCompactBoundary(
                    cwd,
                    sessionIdRef.current,
                    result.boundary,
                  );
                }
                setMessages((prev) => [
                  ...prev,
                  { role: "system", content: `Compact: ${result.message}` },
                ]);
              })
              .catch((err: unknown) => {
                setMessages((prev) => [
                  ...prev,
                  {
                    role: "system",
                    content: `Compact failed: ${asErrorString(err)}`,
                  },
                ]);
              })
              .finally(() => {
                if (abortControllerRef.current === controller) {
                  abortControllerRef.current = null;
                }
                setIsCompacting(false);
              });
          }
          break;
        case "resume": {
          const command = parseSessionResumeCommand(parsed.args);
          if (command.action === "picker") {
            const sessions = sessionMod.listAllSessions();
            setResumePickerOptions(command);
            setResumeSessions(sessions);
            setResumeDialogActive(true);
            break;
          }

          setIsStreaming(true);
          try {
            await clientInitializationRef.current;
            setResumeDialogActive(false);
            const source = SessionManager.open(
              canonicalPath(command.target.cwd ?? cwd),
              command.target.id,
            );
            const prepared = await requestSessionRestoration(
              source,
              cwd,
              askUser,
              {
                destination: command.target.destination,
                copy: command.target.copy,
              },
            );
            if (!prepared || exitingRef.current) {
              setMessages((previous) => [
                ...previous,
                {
                  role: "system",
                  content: "Session restoration canceled; source preserved.",
                },
              ]);
              break;
            }
            await prepared.assertCurrent();
            const manager = prepared.copy
              ? await SessionManager.importStream(
                  prepared.destination,
                  source.exportStream({ scope: "tree", format: "jsonl" }),
                )
              : source;
            interruptAll();
            settleAskQueue();
            followUpResetRef.current();
            setPlanApprovalActive(false);
            await initClient(selectedProviderRef.current, manager);
            const restored = manager.getMessages();
            resetSubagents();
            setResumeDialogActive(false);
            setResumeSessions([]);
            setMessages([
              ...transcriptFromRestored(restored),
              {
                role: "system",
                content: `Resumed session ${manager.id} (${String(restored.length)} messages).`,
              },
            ]);
            dismissNotice();
            setTranscriptRevision((revision) => revision + 1);
          } finally {
            setIsStreaming(false);
          }
          break;
        }
        case "skills": {
          const catalog = skillCatalogRef.current;
          if (!catalog) {
            setMessages((prev) => [
              ...prev,
              { role: "system", content: "Skills: no catalog loaded." },
            ]);
          } else if (parsed.args.trim() === "reload") {
            catalog.reload();
            wireSkillsToRegistry(
              catalog,
              cmdRegistryRef.current,
              skillHostRef.current,
            );
            // Keep the system prompt untouched; newly added skills are sent
            // via skillDelta on the next turn
            const count = catalog.list().length;
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: `Skills reloaded. ${String(count)} skill(s) available.`,
              },
            ]);
          } else {
            const skills = catalog.list();
            if (skills.length === 0) {
              setMessages((prev) => [
                ...prev,
                {
                  role: "system",
                  content: "No skills found in .agents/skills/.",
                },
              ]);
            } else {
              const list = skills
                .map((s) => `  /${s.name} — ${s.description}`)
                .join("\n");
              setMessages((prev) => [
                ...prev,
                {
                  role: "system",
                  content: `Available skills:\n${list}\n\nType /skills reload to hot-reload skills from disk.`,
                },
              ]);
            }
          }
          break;
        }
        case "worktree": {
          try {
            const { execa } = await import("execa");
            const { stdout: output } = await execa(
              "git",
              ["worktree", "list"],
              {
                cwd,
              },
            );
            setMessages((prev) => [
              ...prev,
              { role: "system", content: `Worktree list:\n${output}` },
            ]);
          } catch {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: "Not a git repository or git worktree not available.",
              },
            ]);
          }
          break;
        }
        case "rewind": {
          const fh = fileHistoryRef.current;
          if (!fh?.hasSnapshots()) {
            setMessages((prev) => [
              ...prev,
              { role: "system", content: "No checkpoints to rewind to." },
            ]);
          } else {
            setRewindSnapshots(fh.getSnapshots());
            setRewindDialogActive(true);
          }
          break;
        }
        case "sandbox": {
          const arg = parsed.args.trim();
          if (arg === "off") {
            setSandboxEnabled(false);
            setSandboxAutoAllow(false);
            sandboxEnabledRef.current = false;
            sandboxAutoAllowRef.current = false;
            await disposeSandbox();
            setMessages((prev) => [
              ...prev,
              { role: "system", content: "Sandbox: OFF" },
            ]);
            break;
          }

          const sandbox = await getSandbox();
          const sbAvailable = (await sandbox?.available()) ?? false;
          const unavailableReason =
            sandbox?.availabilityError ?? "sandbox unavailable";
          const autoAllow = arg === "auto";
          const manual = arg === "manual";
          if (autoAllow || manual) {
            setSandboxEnabled(true);
            setSandboxAutoAllow(autoAllow);
            sandboxEnabledRef.current = true;
            sandboxAutoAllowRef.current = autoAllow;
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: `Sandbox: ON + ${autoAllow ? "auto-allow" : "manual permissions"}${sbAvailable ? "" : ` (blocked: ${unavailableReason})`}`,
              },
            ]);
          } else {
            const status = sandboxEnabled
              ? sandboxAutoAllow
                ? "ON + auto-allow"
                : "ON + manual"
              : "OFF";
            const lines = [
              `Sandbox status: ${status}`,
              `Runtime: ${sbAvailable ? "ready" : `blocked (${unavailableReason})`}`,
              "",
              "Usage: /sandbox <mode>",
              "  auto   — Enable sandbox + auto-allow (recommended)",
              "  manual — Enable sandbox + manual permission confirmation",
              "  off    — Disable sandbox",
            ];
            setMessages((prev) => [
              ...prev,
              { role: "system", content: lines.join("\n") },
            ]);
          }
          break;
        }
      }
      return true;
    }

    if (cmd.type === "local") {
      const client = clientRef.current;
      if (
        cmd.name === "thinking" &&
        !parsed.args.trim() &&
        client?.setThinkingLevel
      ) {
        setThinkingDialogActive(true);
        return true;
      }
      const output = cmd.handler({
        cwd,
        args: parsed.args,
        thinkingLevel: () =>
          client?.getThinkingLevel?.() ??
          selectedProviderRef.current.thinking ??
          DEFAULT_THINKING_LEVEL,
        availableThinkingLevels: () =>
          client?.getSupportedThinkingLevels?.() ??
          getSupportedThinkingLevels(selectedProviderRef.current),
        setThinkingLevel: client?.setThinkingLevel
          ? (level) => {
              const runtime = environmentRef.current?.runtime;
              if (!runtime) {
                throw new Error("Agent is not initialized");
              }
              runtime.setThinking(level);
              const updated = runtime.provider;
              persistRuntimeState();
              selectedProviderRef.current = updated;
              setSelectedProvider(updated);
              setProviders((current) =>
                current.map((provider) =>
                  provider.base_url === updated.base_url ? updated : provider,
                ),
              );
            }
          : undefined,
        persistThinkingLevel: (level) => {
          persistThinkingLevel(selectedProviderRef.current.base_url, level);
        },
      });
      setMessages((prev) => [
        ...prev,
        { role: "system", content: output, markdown: cmd.markdown },
      ]);
      return true;
    }

    if (cmd.type === "prompt") {
      if (cmd.agent) {
        setPlanApprovalActive(false);
        const controller = new AbortController();
        abortControllerRef.current = controller;
        setError(null);
        setMessages((prev) => [...prev, { role: "user", content: text }]);
        setIsStreaming(true);
        prepareSubagentTurn();
        output.prepareTurn();
        try {
          const result = await runSubagentCommand(
            cmd.agent,
            cmd.handler({ cwd, args: parsed.args }),
            text,
            {
              cwd,
              sessionId: sessionIdRef.current,
              inputEntry: input,
              registry: registryRef.current,
              conversation: conversationRef.current,
              permissionChecker: checkerRef.current ?? undefined,
              onPermissionRequest: requestPermission,
              abortSignal: controller.signal,
              onEvent: output.createEventHandler((toolId) =>
                subagentCardsRef.current.get(toolId),
              ),
            },
          );
          if (cmd.agent === PLAN_AGENT_NAME && !result.isError) {
            setPlanApprovalActive(true);
          }
        } finally {
          if (abortControllerRef.current === controller) {
            abortControllerRef.current = null;
          }
          output.finishTurn();
          setIsStreaming(false);
        }
        return true;
      }
      // File-based custom command or inline skill: render the body and run it as a user turn.
      const promptText = cmd.handler({ cwd, args: parsed.args });
      if (clientRef.current && promptText.trim()) {
        setError(null);
        setMessages((prev) => [...prev, { role: "user", content: promptText }]);
        conversationRef.current.addUserMessage(promptText, input);
        sessionMod.saveUserMessage(cwd, sessionIdRef.current, input, {
          content: promptText,
        });
        setIsStreaming(true);
        prepareSubagentTurn();
        output.prepareTurn();
        await runAgentLoopWithStats()
          .then(() => {
            setIsStreaming(false);
            output.clearTools();
          })
          .catch((err: unknown) => {
            setError(asErrorString(err));
            setIsStreaming(false);
          });
      }
      return true;
    }

    if (cmd.type === "skill_fork") {
      const skill = skillCatalogRef.current?.get(parsed.name);
      if (!skill) {
        setMessages((prev) => [
          ...prev,
          { role: "system", content: `Skill not found: ${parsed.name}` },
        ]);
        return true;
      }
      const client = clientRef.current;
      if (!client) {
        setMessages((prev) => [
          ...prev,
          { role: "system", content: CLIENT_NOT_READY },
        ]);
        return true;
      }
      setMessages((prev) => [
        ...prev,
        {
          role: "system",
          content: `Running skill "${parsed.name}" in fork mode…`,
        },
      ]);
      const controller = new AbortController();
      abortControllerRef.current = controller;
      setIsStreaming(true);
      // Build a SkillForkHost backed by the live refs. The optional signal lets
      // the skill executor forward cancellation while the fallback keeps this
      // slash invocation on the TUI's foreground controller.
      const forkHost: SkillForkHost = {
        ...skillHostRef.current,
        runSubagent: (prompt: string, signal?: AbortSignal) =>
          spawnSubagent(
            {
              name: skill.meta.name,
              description: skill.meta.description,
              model: skill.meta.model,
            },
            prompt,
            client,
            registryRef.current,
            selectedProviderRef.current,
            cwd,
            undefined,
            undefined,
            undefined,
            checkerRef.current?.forCwd(cwd),
            {
              abortSignal: signal ?? controller.signal,
              onPermissionRequest: requestPermission,
            },
          ),
        snapshotParentMessages: (count) => {
          const msgs = conversationRef.current.getMessages();
          return msgs
            .slice(-count)
            .map((m) => `[${m.role}] ${contentToText(m.content)}`)
            .join("\n");
        },
      };
      try {
        const result = await runSkillFork(
          skill,
          parsed.args,
          forkHost,
          controller.signal,
        );
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: result },
        ]);
      } catch (err: unknown) {
        setMessages((prev) => [
          ...prev,
          {
            role: "system",
            content: `Skill fork error: ${asErrorString(err)}`,
          },
        ]);
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        setIsStreaming(false);
      }
      return true;
    }

    return false;
  };

  // Central guard for every slash-command entry point (interactive submit,
  // startup --resume, dialog callbacks): a throwing command surfaces as a
  // user-visible message and leaves the app re-operable instead of escaping as
  // an unhandled rejection. This only catches expected command failures — the
  // global unknown-crash handling in recover.ts is left intact.
  const handleSlashCommand = async (
    text: string,
    input?: historyMod.InputEntry,
  ): Promise<boolean> => {
    try {
      return await runSlashCommand(text, input);
    } catch (err) {
      log.error({ err, text }, "slash command failed");
      setMessages((prev) => [
        ...prev,
        { role: "system", content: `Error: ${asErrorString(err)}` },
      ]);
      return true;
    }
  };

  const runAgentLoop = async (modeOverride?: PermissionMode) => {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const onAgentEvent = output.createEventHandler((toolId) =>
      subagentCardsRef.current.get(toolId),
    );

    // modeOverride avoids a stale-closure read of permMode right after a
    // setPermMode call in the same tick.
    const checker = checkerRef.current ?? new PermissionChecker(cwd);
    checker.mode = modeOverride ?? permModeRef.current;
    checkerRef.current = checker;

    const bashTool = registryRef.current.getInstanceOf("Bash", BashTool);
    const sandboxReady = bashTool
      ? await configureBashSandbox(bashTool)
      : false;

    // Auto-allow is safe only when the sandbox is actually ready.
    checker.sandboxEnabled = sandboxEnabledRef.current && sandboxReady;
    checker.sandboxAutoAllow = sandboxAutoAllowRef.current && sandboxReady;
    const agent = environmentRef.current?.runtime;
    if (!agent) {
      return;
    }
    const client = clientRef.current;
    if (!client) {
      throw new Error("LLM client not ready yet");
    }
    clientRef.current = await agent.updateProvider(
      selectedProviderRef.current,
      client,
    );
    agent.contextWindow = contextWindowRef.current;
    agent.toolFilter = toolFilterRef.current;
    controller.signal.addEventListener(
      "abort",
      () => {
        agent.abortForeground();
      },
      { once: true },
    );

    agentRef.current = agent;
    let exitPlanSucceeded = false;

    try {
      for await (const event of agent.run(null, {
        onPermissionRequest: requestPermission,
      })) {
        onAgentEvent(event);
        if (event.type === "turn_complete") {
          persistRuntimeState();
        }
        switch (event.type) {
          case "tool_use": {
            if (activeToolIdsRef.current.size === 0) {
              activeToolBatchStartedAtRef.current = Date.now();
            }
            activeToolIdsRef.current.add(event.toolId);
            break;
          }
          case "tool_result": {
            activeToolIdsRef.current.delete(event.toolId);
            if (
              activeToolIdsRef.current.size === 0 &&
              activeToolBatchStartedAtRef.current !== null
            ) {
              interactionStatsRef.current.toolTimeMs +=
                Date.now() - activeToolBatchStartedAtRef.current;
              activeToolBatchStartedAtRef.current = null;
            }
            if (event.isError) {
              interactionStatsRef.current.failedToolCalls += 1;
            } else {
              interactionStatsRef.current.successfulToolCalls += 1;
            }
            if (
              (event.toolName === "ExitPlanMode" ||
                event.toolName === "EnterPlanMode") &&
              !event.isError
            ) {
              exitPlanSucceeded = true;
            }
            // @-mention completion must see files the agent just wrote.
            if (
              event.toolName === "WriteFile" ||
              event.toolName === "EditFile"
            ) {
              setFileFactsVersion((v) => v + 1);
            }
            const recent = recentToolsRef.current;
            const dup = recent.indexOf(event.toolName);
            if (dup >= 0) {
              recent.splice(dup, 1);
            }
            recent.push(event.toolName);
            if (recent.length > MAX_RECENT_TOOLS) {
              recent.shift();
            }
            break;
          }
          case "steering_delivered": {
            setSteeringPending((prev) =>
              prev.filter((input) => input.id !== event.inputId),
            );
            setMessages((prev) => [
              ...prev,
              { role: "user", content: event.text },
            ]);
            break;
          }
          case "loop_complete": {
            if (permModeRef.current === "plan" && exitPlanSucceeded) {
              setPlanApprovalActive(true);
            }
            break;
          }
          case "error": {
            throw event.error;
          }
        }
      }
    } finally {
      agentRef.current = null;
      // The run may have created/renamed files through any tool (Bash, git,
      // subagents); refresh the @-mention cache once it ends.
      setFileFactsVersion((v) => v + 1);
      const leftover = agent.takeSteeringLeftovers();
      if (leftover.length > 0) {
        const ids = new Set(leftover.map((message) => message.input.id));
        setSteeringPending((prev) =>
          prev.filter((input) => !ids.has(input.id)),
        );
        if (!exitingRef.current) {
          for (const message of leftover) {
            followUps.enqueue(message.text, message.input);
          }
        }
      }
    }
  };

  const runAgentLoopWithStats = async (modeOverride?: PermissionMode) => {
    const startedAt = Date.now();
    try {
      await runAgentLoop(modeOverride);
    } finally {
      const endedAt = Date.now();
      interactionStatsRef.current.agentActiveMs += endedAt - startedAt;
      if (activeToolBatchStartedAtRef.current !== null) {
        interactionStatsRef.current.toolTimeMs +=
          endedAt - activeToolBatchStartedAtRef.current;
        activeToolBatchStartedAtRef.current = null;
        activeToolIdsRef.current.clear();
      }
    }
  };

  const runAgentTurn = async (
    prepare?: () => Promise<void>,
    modeOverride?: PermissionMode,
  ) => {
    if (!clientRef.current || initializationStateRef.current !== "ready") {
      throw new Error("LLM client not ready yet");
    }

    setIsStreaming(true);
    prepareSubagentTurn();
    output.prepareTurn();
    setError(null);
    // Uniformly (re)initialize the plan-approval state at every run entry so a
    // stale/expired approval from a previous run never resurfaces on this one
    // (including notification turns).
    setPlanApprovalActive(false);

    try {
      await prepare?.();
      await runAgentLoopWithStats(modeOverride);
    } catch (err) {
      const msg = asErrorString(err);
      const isAbort =
        strArg(asRecord(err), "name") === "AbortError" || msg.includes("abort");
      if (isAbort) {
        const partialText = streamingTextRef.current;
        if (partialText) {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: partialText + "\n\n*[cancelled]*" },
          ]);
        }
        setMessages((prev) => [
          ...prev,
          { role: "system", content: "(response interrupted)" },
        ]);
      } else {
        const partialText = streamingTextRef.current;
        if (partialText) {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: partialText },
          ]);
        }
        setError(msg);
        setMessages((prev) => [
          ...prev,
          { role: "system", content: `Error: ${msg}` },
        ]);
      }
    } finally {
      setIsStreaming(false);
      output.finishTurn();
      abortControllerRef.current = null;
      subagentCardsRef.current.clear();
    }
  };

  const runUserTurn = async (
    text: string,
    input: historyMod.InputEntry,
    modeOverride?: PermissionMode,
  ) => {
    await runAgentTurn(async () => {
      persistRuntimeState();
      setMessages((prev) => [...prev, { role: "user", content: text }]);
      const expanded = await expandAtRefsWithImages(text, cwd);
      conversationRef.current.addUserMessage(expanded, input);
      sessionMod.saveUserMessage(cwd, sessionIdRef.current, input, {
        content: expanded,
      });
    }, modeOverride);
  };

  const runNotificationTurn = async (): Promise<void> => {
    await runAgentTurn();
  };

  const handlePlanApproval = useCallback(
    (choice: PlanChoice, feedback?: string) => {
      setPlanApprovalActive(false);
      const planPath = getOrCreatePlanPath(planOwner());
      let planContent = "";
      try {
        if (existsSync(planPath)) {
          planContent = readFileSync(planPath, "utf-8");
        }
      } catch {
        /** noop */
      }

      if (choice === "yolo") {
        planOwner().exitPlanMode("bypassPermissions");

        conversationRef.current.addSystemReminder(
          buildPlanModeExitReminder(planPath, !!planContent),
        );
        setMessages((prev) => [
          ...prev,
          { role: "system", content: "Plan approved. Entered YOLO mode." },
        ]);
        if (planContent) {
          handleSubmit(buildPlanExecutionPrompt(planContent));
        }
      } else if (choice === "manual") {
        planOwner().exitPlanMode("default");
        conversationRef.current.addSystemReminder(
          buildPlanModeExitReminder(planPath, !!planContent),
        );
        setMessages((prev) => [
          ...prev,
          {
            role: "system",
            content: "Plan approved. Each edit requires confirmation.",
          },
        ]);
        if (planContent) {
          handleSubmit(buildPlanExecutionPrompt(planContent));
        }
      } else if (choice === "feedback" && feedback) {
        handleSubmit(feedback);
      }
    },
    [cwd],
  );

  const rewindConversation = (snap: Snapshot): ChatMessage[] => {
    const manager =
      sessionManagerRef.current ??
      SessionManager.open(cwd, sessionIdRef.current);
    manager.refresh();
    const result = manager.navigate(snap.entryId);
    interruptAll();
    settleAskQueue();
    followUpResetRef.current();
    setPlanApprovalActive(false);
    fileStateCacheRef.current.clear();
    activeSkillsRef.current.clear();
    toolFilterRef.current = null;
    conversationRef.current.reset();
    conversationRef.current.appendMessages(manager.getMessages());
    if (result.input) {
      insertInputTextRef.current?.(result.input);
    }
    return transcriptFromRestored(manager.getMessages());
  };

  const navigateTree = async (entryId: string, summary?: string) => {
    const manager = sessionManagerRef.current;
    const runtime = environmentRef.current?.runtime;
    if (!manager || !runtime || abortControllerRef.current) {
      return;
    }
    manager.refresh();
    const originalLeaf = manager.leafId;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setTreeOpen(false);
    setIsStreaming(true);
    let selectedLeaf: string | null | undefined;
    try {
      const result = await navigateSessionTree(
        runtime,
        manager,
        entryId,
        summary,
        controller.signal,
      );
      selectedLeaf = manager.leafId;
      interruptAll();
      settleAskQueue();
      followUpResetRef.current();
      setPlanApprovalActive(false);
      await initClient(selectedProviderRef.current, manager);
      if (!environmentRef.current) {
        throw new Error("Failed to rebuild session environment.");
      }
      resetSubagents();
      setMessages(transcriptFromRestored(manager.getMessages()));
      setTranscriptRevision((revision) => revision + 1);
      if (result.input) {
        insertInputTextRef.current?.(result.input);
      }
    } catch (error) {
      if (selectedLeaf !== undefined) {
        manager.refresh();
        if (manager.leafId === selectedLeaf) {
          manager.selectActiveLeaf(originalLeaf);
        }
      }
      throw error;
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      setIsStreaming(false);
    }
  };

  const handleRewindAction = useCallback(
    (action: RewindAction) => {
      setRewindDialogActive(false);
      const fh = fileHistoryRef.current;
      if (!fh || action.type === "cancel") {
        return;
      }
      const snapshot = rewindSnapshots[action.snapshotIndex];
      if (!snapshot) {
        setError("That checkpoint is no longer available. Reopen /rewind.");
        return;
      }
      try {
        switch (action.type) {
          case "code_and_conversation": {
            const changed = fh.rewind(snapshot.id);
            fileStateCacheRef.current.clear();
            const transcript = rewindConversation(snapshot);
            followUpResetRef.current();
            void stopMemoryTasks();
            const fileList =
              changed.length > 0
                ? "\n" + changed.map((f) => "  " + f).join("\n")
                : "";
            setMessages([
              ...transcript,
              {
                role: "system",
                content: `⟲ Rewound to checkpoint. Restored ${String(changed.length)} file(s) and conversation.${fileList}`,
              },
            ]);
            setTranscriptRevision((revision) => revision + 1);
            break;
          }
          case "conversation_only": {
            const transcript = rewindConversation(snapshot);
            fileStateCacheRef.current.clear();
            followUpResetRef.current();
            void stopMemoryTasks();
            setMessages([
              ...transcript,
              {
                role: "system",
                content: `⟲ Rewound conversation. Files unchanged.`,
              },
            ]);
            setTranscriptRevision((revision) => revision + 1);
            break;
          }
          case "code_only": {
            const changed = fh.rewind(snapshot.id);
            fileStateCacheRef.current.clear();
            const fileList =
              changed.length > 0
                ? "\n" + changed.map((f) => "  " + f).join("\n")
                : "";
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: `⟲ Restored ${String(changed.length)} file(s). Conversation unchanged.${fileList}`,
              },
            ]);
            break;
          }
        }
      } catch (error) {
        setError(`Rewind failed: ${asErrorString(error)}`);
      }
    },
    [rewindSnapshots, stopMemoryTasks],
  );

  /**
   * Before each turn, check whether the skill directory changed; if so, reload
   * the catalog and rewire the slash commands. The system prompt stays
   * untouched: newly added skills are delivered by skillDelta as a
   * system-reminder on the next turn, since mutating the system prompt would
   * invalidate the entire cached prefix.
   */
  const refreshSkillsIfNeeded = () => {
    const catalog = skillCatalogRef.current;
    if (!catalog) {
      return;
    }
    if (!catalog.needsReload()) {
      return;
    }
    catalog.reload();
    wireSkillsToRegistry(catalog, cmdRegistryRef.current, skillHostRef.current);
  };

  const processSubmission = async (
    text: string,
    input?: historyMod.InputEntry,
  ) => {
    refreshSkillsIfNeeded();
    if (text.startsWith("/") && (await handleSlashCommand(text, input))) {
      return;
    }
    if (
      initializationStateRef.current !== "ready" ||
      !clientRef.current ||
      !environmentRef.current
    ) {
      throw new Error("LLM client not ready yet");
    }
    await runUserTurn(text, input ?? recordCliInput(text));
  };

  const workflowService = getWorkflowService(registryRef.current);
  const turnBlocked =
    settingsOpen ||
    exitingRef.current ||
    appState !== "chat" ||
    initializationState !== "ready" ||
    !clientRef.current ||
    isStreaming ||
    userBash.running ||
    isCompacting ||
    mcpBusy ||
    providerSwitching ||
    loginActive ||
    providerDialogActive ||
    modelDialogActive ||
    thinkingDialogActive ||
    planApprovalActive ||
    treeOpen ||
    rewindDialogActive ||
    resumeDialogActive ||
    permissionRequest !== null ||
    askRequest !== null ||
    agentsDialogOpen ||
    workflowsDialogOpen;
  const followUps = useFollowUpQueue({
    mode: preferences.follow_up_mode,
    sendBatch: async (entries) => {
      refreshSkillsIfNeeded();
      await runAgentTurn(async () => {
        persistRuntimeState();
        for (const entry of entries) {
          const input = entry.input ?? recordCliInput(entry.text);
          const expanded = await expandAtRefsWithImages(entry.text, cwd);
          conversationRef.current.addUserMessage(expanded, input);
          sessionMod.saveUserMessage(cwd, sessionIdRef.current, input, {
            content: expanded,
          });
          setMessages((previous) => [
            ...previous,
            { role: "user", content: entry.text },
          ]);
        }
      });
    },
    blocked: turnBlocked,
    send: processSubmission,
    onError: (error) => {
      setError(asErrorString(error));
    },
  });
  followUpResetRef.current = followUps.reset;
  const pendingMessages = followUps.messages;

  useNotificationWakeup({
    blocked:
      turnBlocked || followUps.processing || followUps.messages.length > 0,
    hasPending: () =>
      teamManagerRef.current.hasLeaderNotifications() ||
      backgroundTaskManagerRef.current.hasNotifications(),
    run: runNotificationTurn,
    onError: (error) => {
      setError(asErrorString(error));
    },
  });

  /**
   * pi-style message routing: while the agent runs, plain text is steered into
   * the in-flight run (injected at the next turn boundary); slash commands and
   * messages sent while a dialog owns the input keep queueing as follow-ups.
   */
  const handleSubmit = (text: string): boolean => {
    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }
    dismissNotice();
    if (initializationStateRef.current !== "ready") {
      if (
        /^\/(?:help|commands|quit|provider|login|clear)(?:\s|$)|^\/mcp\s+reload\s*$/u.test(
          trimmed,
        )
      ) {
        void handleSlashCommand(trimmed).catch((error: unknown) => {
          setError(asErrorString(error));
        });
        return true;
      }
      if (initializationStateRef.current === "failed") {
        return false;
      }
    }
    if (
      (isStreaming ||
        userBash.running ||
        isCompacting ||
        followUps.processing) &&
      /^(?:\/warming(?:\s+(?:status|stop|resume))?|\/retry(?:\s+(?:status|on|off|abort))?)$/u.test(
        trimmed,
      )
    ) {
      void handleSlashCommand(trimmed).catch((error: unknown) => {
        setError(asErrorString(error));
      });
      return true;
    }
    const goalControl = /^\/goal(?:\s+(status|pause|clear|complete))?$/u.exec(
      trimmed,
    );
    if (isStreaming && goalControl) {
      recordCliInput(trimmed, "goal");
      const result = handleGoalCommand(currentGoal(), goalControl[1] ?? "");
      setMessages((prev) => [
        ...prev,
        { role: "system", content: result.message },
      ]);
      return true;
    }
    if (isStreaming && !trimmed.startsWith("/") && agentRef.current) {
      const input = recordCliInput(trimmed);
      agentRef.current.steer(trimmed, input);
      setSteeringPending((prev) => [...prev, input]);
      return true;
    }
    followUps.enqueue(text);
    return true;
  };

  const handleComposerSubmit = (text: string): boolean => {
    if (initializationStateRef.current !== "ready") {
      return text.trimStart().startsWith("!") ? false : handleSubmit(text);
    }
    const shellSubmission = userBash.submit(text);
    if (shellSubmission !== undefined) {
      return shellSubmission;
    }
    return handleSubmit(text);
  };

  /**
   * Recall the latest queued message back into the editor: follow-ups first,
   * then messages steered into the in-flight run.
   */
  const recallQueuedMessage = (): string | undefined => {
    const followUp = followUps.takeLast();
    if (followUp !== undefined) {
      return followUp;
    }
    const steered = steeringPending.at(-1);
    if (steered !== undefined && agentRef.current?.removeSteering(steered.id)) {
      setSteeringPending((prev) => prev.slice(0, -1));
      return steered.text;
    }
    return undefined;
  };

  useEffect(() => {
    if (!resume || appState !== "chat" || initialResumeHandledRef.current) {
      return;
    }
    initialResumeHandledRef.current = true;
    void handleSlashCommand(resume === true ? "/resume" : `/resume ${resume}`);
  }, [appState, resume]);

  const handleLogin = async (input: ProviderConfig): Promise<void> => {
    const environment = detectEnvironment(cwd, {
      skipGit: environmentRef.current?.project.trusted !== true,
    });
    environment.model = input.model;
    // Construct before saving so invalid client configuration leaves the form editable.
    const client = await createClient(input, buildSystemPrompt(environment));
    const saved = saveProvider(input, providers);
    setProviders(saved.providers);
    setError("");
    if (clientRef.current) {
      const runtime = environmentRef.current?.runtime;
      if (!runtime) {
        throw new Error("Agent is not initialized");
      }
      clientRef.current = await runtime.updateProvider(saved.provider, client);
      selectedProviderRef.current = runtime.provider;
      setSelectedProvider(runtime.provider);
      persistRuntimeState();
      rememberProvider(saved.provider, saved.providers);
      contextWindowRef.current = getContextWindow(saved.provider);
      maxOutputRef.current = getMaxOutputTokens(saved.provider);
      decideAndApply(
        registryRef.current,
        saved.provider.base_url,
        saved.provider.protocol,
      );
      setMessages((current) => [
        ...current,
        {
          role: "system",
          content: `Provider ${saved.provider.name} activated. ${saved.replaced ? "Updated" : "Saved to"} ~/.yukino/config.yaml.`,
        },
      ]);
    } else {
      handleProviderSelect(saved.provider, saved.providers);
    }
    setLoginActive(false);
  };

  const thinkingLevel =
    clientRef.current?.getThinkingLevel?.() ??
    selectedProvider.thinking ??
    DEFAULT_THINKING_LEVEL;
  const availableThinkingLevels =
    clientRef.current?.getSupportedThinkingLevels?.() ??
    getSupportedThinkingLevels(selectedProvider);
  const loginInitialValues = {
    ...selectedProvider,
    thinking: thinkingLevel,
  };

  if (appState === "providerSelect" && loginActive) {
    return (
      <ProviderLogin
        initialValues={loginInitialValues}
        onSubmit={handleLogin}
        onCancel={() => {
          if (providers.length === 0) {
            requestExit();
          } else {
            setLoginActive(false);
          }
        }}
      />
    );
  }
  if (appState === "providerSelect") {
    return (
      <ProviderSelect
        providers={providers}
        reservedRows={0}
        onSelect={handleProviderSelect}
      />
    );
  }

  return (
    <DisplayPreferencesContext.Provider value={preferences.display}>
      <TerminalLayout
        transcript={
          <Transcript
            messages={messages}
            sessionId={sessionIdRef.current}
            expanded={toolsExpanded}
            model={selectedProvider.model || selectedProvider.name}
            cwd={cwd}
            provider={selectedProvider.name}
            revision={transcriptRevision}
          />
        }
        activity={
          <>
            <ChatView
              streamingText={isStreaming ? streamingText : undefined}
              thinkingText={isStreaming ? streamingThinking : undefined}
              expanded={toolsExpanded}
            />

            <AgentActivity
              tools={activeTools}
              subagents={subagents}
              backgroundTasks={backgroundTasks}
              teammates={teammateStates}
              isAsking={askRequest !== null}
              expanded={toolsExpanded}
            />
            {userBash.tool && (
              <ToolBlock tool={userBash.tool} expanded={toolsExpanded} />
            )}

            {error && (
              <Box marginTop={1} paddingLeft={1}>
                <Text color={THEME.error}>Error: {error}</Text>
              </Box>
            )}
          </>
        }
        status={
          <>
            <UpdateNotice latestVersion={noticeVersion} />
            <PendingQueue
              state={
                initializationState === "failed"
                  ? "failed"
                  : initializationState !== "ready"
                    ? "initializing"
                    : isStreaming || (followUps.processing && !mcpBusy)
                      ? "running"
                      : "queued"
              }
              messages={pendingMessages}
              steering={steeringPending.map((input) => input.text)}
            />
            {ctrlCHint && (
              <Box paddingLeft={1}>
                <Text color={THEME.dim}>Press Ctrl+C again to exit.</Text>
              </Box>
            )}
            <Box width="100%" justifyContent="space-between">
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <TodoProgress
                  key={`${sessionIdRef.current}:${boardId}`}
                  tasks={todos}
                />
              </Box>
              <Box flexShrink={1} minWidth={0} justifyContent="flex-end">
                <AgentStatus
                  teammates={teammateStates.length}
                  backgroundSubagents={backgroundSubagents.length}
                  backgroundShells={backgroundShells}
                />
              </Box>
            </Box>
          </>
        }
        dock={
          <InteractionDock
            settings={
              settingsOpen
                ? {
                    values: preferences,
                    sources:
                      environmentRef.current?.project
                        .getSources()
                        .map((source) =>
                          source.field in settingsOverridesRef.current
                            ? { ...source, scope: "override" as const }
                            : source,
                        ) ?? [],
                    model: selectedProvider.model,
                    thinking: thinkingLevel,
                    onClose: () => {
                      setSettingsOpen(false);
                    },
                    onThinking: () => {
                      const runtime = environmentRef.current?.runtime;
                      if (!runtime) {
                        return;
                      }
                      const levels =
                        runtime.client.getSupportedThinkingLevels?.() ??
                        getSupportedThinkingLevels(runtime.provider);
                      runtime.setThinking(
                        levels[
                          (levels.indexOf(thinkingLevel) + 1) % levels.length
                        ],
                      );
                      selectedProviderRef.current = runtime.provider;
                      setSelectedProvider({ ...runtime.provider });
                      persistRuntimeState();
                    },
                    onModel: async () => {
                      const environment = environmentRef.current;
                      if (!environment) {
                        return;
                      }
                      const available = environment.config.providers;
                      if (!available.length) {
                        return;
                      }
                      const index = available.findIndex(
                        (provider) =>
                          provider.name === selectedProviderRef.current.name,
                      );
                      const provider =
                        available[(index + 1) % available.length];
                      const env = detectEnvironment(cwd, {
                        skipGit: !environment.project.trusted,
                      });
                      env.model = provider.model;
                      const client = await createClient(
                        provider,
                        buildSystemPrompt(env),
                      );
                      clientRef.current =
                        await environment.runtime.updateProvider(
                          provider,
                          client,
                        );
                      selectedProviderRef.current =
                        environment.runtime.provider;
                      setSelectedProvider({ ...environment.runtime.provider });
                      contextWindowRef.current =
                        environment.runtime.contextWindow;
                      maxOutputRef.current = getMaxOutputTokens(provider);
                      decideAndApply(
                        environment.runtime.registry,
                        provider.base_url,
                        provider.protocol,
                      );
                      persistRuntimeState();
                    },
                    onChange: async (patch, persist) => {
                      const environment = environmentRef.current;
                      if (!environment) {
                        return;
                      }
                      if (persist) {
                        persistPreferences(patch, invocationOptions.config);
                      }
                      if (patch.theme === "auto" && resolveAutoTheme) {
                        detectedThemeRef.current = await resolveAutoTheme();
                      }
                      applyRuntimePreferences(environment.runtime, patch);
                      settingsOverridesRef.current = mergePreferences(
                        settingsOverridesRef.current,
                        patch,
                      );
                      setPreferences(
                        structuredClone(environment.runtime.preferences),
                      );
                      setThemeMode(
                        environment.runtime.preferences.theme === "auto"
                          ? detectedThemeRef.current
                          : environment.runtime.preferences.theme,
                      );
                      await environment.runtime.cache.invalidate(
                        "branch_change",
                      );
                      setTranscriptRevision((value) => value + 1);
                    },
                  }
                : undefined
            }
            tree={
              treeOpen && sessionManagerRef.current
                ? {
                    tree: sessionManagerRef.current.getTree(),
                    leafId: sessionManagerRef.current.leafId,
                    options: treeOptions,
                    onOptionsChange: setTreeOptions,
                    initialQuery: treeQueryRef.current,
                    onCancel: () => {
                      setTreeOpen(false);
                    },
                    onSelect: (id) => {
                      void navigateTree(id, treeSummaryRef.current).catch(
                        (error: unknown) => {
                          setError(asErrorString(error));
                        },
                      );
                    },
                  }
                : undefined
            }
            login={
              loginActive
                ? {
                    initialValues: loginInitialValues,
                    onSubmit: handleLogin,
                    onCancel: () => {
                      setLoginActive(false);
                    },
                  }
                : undefined
            }
            provider={
              providerDialogActive
                ? {
                    providers,
                    currentProviderIndex: providerIndexOf(selectedProvider),
                    onCancel: () => {
                      setProviderDialogActive(false);
                    },
                    onSelect: handleProviderSelect,
                  }
                : undefined
            }
            model={
              modelDialogActive
                ? {
                    currentModel: selectedProvider.model,
                    state: modelDialogState,
                    onCancel: closeModelPicker,
                    onSelect: (model) => {
                      closeModelPicker();
                      void applyModel(model.id);
                    },
                  }
                : undefined
            }
            thinking={
              thinkingDialogActive
                ? {
                    currentLevel: thinkingLevel,
                    levels: availableThinkingLevels,
                    onSelect: (level) => {
                      setThinkingDialogActive(false);
                      void handleSlashCommand(`/thinking ${level}`);
                    },
                    onCancel: () => {
                      setThinkingDialogActive(false);
                    },
                  }
                : undefined
            }
            planApproval={
              planApprovalActive ? { onSelect: handlePlanApproval } : undefined
            }
            rewind={
              rewindDialogActive
                ? {
                    snapshots: rewindSnapshots,
                    onComplete: handleRewindAction,
                    onCancel: () => {
                      setRewindDialogActive(false);
                    },
                  }
                : undefined
            }
            resume={
              resumeDialogActive
                ? {
                    sessions: resumeSessions,
                    cwd,
                    allProjects: resumePickerOptions.allProjects,
                    includeArchived: resumePickerOptions.includeArchived,
                    initialQuery: resumePickerOptions.query,
                    currentSessionId: sessionIdRef.current,
                    onRename: (session, name) =>
                      Promise.resolve().then(() => {
                        const active = sessionManagerRef.current;
                        const manager =
                          active?.id === session.id &&
                          active.cwd === canonicalPath(session.cwd)
                            ? active
                            : SessionManager.open(session.cwd, session.id);
                        manager.refresh();
                        manager.setName(name);
                        setResumeSessions(sessionMod.listAllSessions());
                      }),
                    onDelete: (session) =>
                      Promise.resolve().then(() => {
                        if (
                          session.id === sessionIdRef.current &&
                          canonicalPath(session.cwd) === canonicalPath(cwd)
                        ) {
                          throw new Error(
                            "Switch away from the current session before deleting it",
                          );
                        }
                        const target = {
                          cwd: session.cwd,
                          sessionId: session.id,
                        };
                        const plan = sessionMod.planSessionMaintenance(
                          target,
                          "delete",
                        );
                        sessionMod.executeSessionMaintenance(target, plan, {
                          confirmed: true,
                          planId: plan.planId,
                        });
                        setResumeSessions(sessionMod.listAllSessions());
                      }),
                    onCancel: () => {
                      setResumeDialogActive(false);
                    },
                    onSelect: (sessionId, sourceCwd) => {
                      setResumeDialogActive(false);
                      void handleSlashCommand(
                        `/resume ${JSON.stringify({ id: sessionId, cwd: sourceCwd })}`,
                      );
                    },
                  }
                : undefined
            }
            permission={
              permissionRequest
                ? {
                    ...permissionRequest,
                    onComplete: (action) => {
                      permissionResolveRef.current?.(action);
                      permissionResolveRef.current = null;
                      setPermissionRequest(null);
                      permissionQueueRef.current.shift()?.present();
                    },
                  }
                : undefined
            }
            askUser={
              askRequest
                ? {
                    requestId: askRequestId,
                    questions: askRequest,
                    onComplete: (answers) => {
                      if (askQueueRef.current[0]?.id !== askRequestId) {
                        return;
                      }
                      const head = askQueueRef.current.shift();
                      head?.resolve(answers);
                      const next = askQueueRef.current[0];
                      if (next) {
                        setAskRequestId(next.id);
                      }
                      setAskRequest(next ? next.questions : null);
                    },
                  }
                : undefined
            }
            workflows={
              workflowsDialogOpen && workflowService
                ? {
                    service: workflowService,
                    context: () => ({
                      cwd,
                      permissionChecker: checkerRef.current ?? undefined,
                      onPermissionRequest: requestPermission,
                    }),
                    onClose: () => {
                      setWorkflowsDialogOpen(false);
                    },
                  }
                : undefined
            }
            agents={
              agentsDialogOpen
                ? {
                    teammates: teammateStates,
                    backgroundTasks: runningBackgroundTasks,
                    subagents,
                    onClose: () => {
                      setAgentsDialogOpen(false);
                    },
                    onKill: (name, teamName) => {
                      const team = teamManagerRef.current.get(teamName);
                      if (team) {
                        void team.stopMember(name);
                      }
                    },
                    onStopBackground: (taskId) => {
                      void backgroundTaskManagerRef.current
                        .stopAndWait(taskId)
                        .catch((error: unknown) => {
                          setError(asErrorString(error));
                        });
                    },
                    onShutdown: (name, teamName) => {
                      const team = teamManagerRef.current.get(teamName);
                      if (team) {
                        const request = shutdownRequest(
                          LEADER_NAME,
                          "Please finish and exit",
                        );
                        void team
                          .getMember(name)
                          ?.mailbox.send(LEADER_NAME, request.text, request);
                      }
                    },
                  }
                : undefined
            }
            composer={{
              onSubmit: handleComposerSubmit,
              disabled: providerSwitching,
              history: promptHistory,
              commands: cmdRegistryRef.current.listCommands(),
              thinkingLevels: availableThinkingLevels,
              onRecallQueuedMessage: recallQueuedMessage,
              onOpenAgents:
                teammateStates.length > 0 || runningBackgroundTasks.length > 0
                  ? () => {
                      setAgentsDialogOpen(true);
                    }
                  : undefined,
              usageTracker: usageTrackerRef.current,
              inputState: error
                ? "error"
                : isStreaming ||
                    userBash.running ||
                    isCompacting ||
                    providerSwitching
                  ? "agent"
                  : "focused",
              borderColor:
                activityStatus === "idle" || activityStatus === "working"
                  ? thinkingLevelColor(thinkingLevel)
                  : activityStatusColor(activityStatus),
              statusLabel: error
                ? initializationState === "failed"
                  ? "Initialization failed · /mcp reload to retry"
                  : "Error"
                : initializationState === "initializing"
                  ? "Initializing agent..."
                  : mcpBusy
                    ? "Managing MCP... (Esc to cancel)"
                    : providerSwitching
                      ? "Switching provider..."
                      : isCompacting
                        ? "Compacting context... (Esc to cancel)"
                        : userBash.running
                          ? userBash.backgroundAllowed &&
                            registryRef.current
                              .getInstanceOf("Bash", BashTool)
                              ?.backgroundEnabled()
                            ? "Running Bash... (Ctrl+B background · Esc cancel)"
                            : "Running Bash... (Esc to cancel)"
                          : isStreaming
                            ? (output.retryStatus ?? "Working")
                            : undefined,
              permMode,
              onModeChange: (mode) => {
                if (permModeRef.current === "plan") {
                  const planPath = checkerRef.current?.planFilePath ?? "";
                  conversationRef.current.addSystemReminder(
                    buildPlanModeExitReminder(
                      planPath,
                      !!planPath && planExists(planOwner()),
                    ),
                  );
                  planOwner().exitPlanMode(mode);
                } else {
                  planOwner().mode = mode;
                }
              },
              cwd,
              sessionId: sessionIdRef.current,
              fileFactsVersion,
              insertTextRef: insertInputTextRef,
              clearRef: clearInputRef,
              onEscape: () => {
                if (foregroundBusy) {
                  interruptUserWork();
                }
              },
            }}
          />
        }
        footer={
          <Footer
            contextTokens={currentContextTokens(conversationRef.current)}
            contextWindow={contextWindowRef.current}
            inputTokens={inputTokens}
            model={selectedProvider.model}
            thinkingLevel={thinkingLevel}
            outputTokens={outputTokens}
            permissionMode={permMode}
            provider={selectedProvider.name}
            sessionId={sessionIdRef.current}
            cwd={cwd}
          />
        }
      />
    </DisplayPreferencesContext.Provider>
  );
}
