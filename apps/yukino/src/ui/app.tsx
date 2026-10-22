import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { Box, Text, useApp } from "ink";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";

import { Agent } from "@/agent/index.js";
import type { InteractionSummary } from "@/bootstrap/interaction-summary.js";
import {
  buildComposedToolFilter,
  countMcpTools,
  createToolRegistry,
  removeMcpTools,
  wireSkillsToRegistry,
} from "@/bootstrap/tool-registry.js";
import {
  resolve as resolveCommand,
  createDefaultRegistry as createCommandRegistry,
} from "@/commands/commands.js";
import { loadUserCommands } from "@/commands/loader.js";
import { runSubagentCommand } from "@/commands/subagent.js";
import { CommandUsageTracker } from "@/commands/usage-tracker.js";
import { currentContextTokens, forceCompact } from "@/compact/compact.js";
import { RecoveryState } from "@/compact/recovery.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_THINKING_LEVEL,
} from "@/config/constants.js";
import type {
  AppConfig,
  McpLoading,
  MCPServerConfig,
  HookConfig,
  SandboxYamlConfig,
} from "@/config/index.js";
import { loadConfig, withProjectMcpServers } from "@/config/index.js";
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
import {
  runFeedbackPipeline,
  type PipelineResult,
} from "@/feedback/pipeline.js";
import type {
  FeedbackOptions,
  IssueConfirmation,
  IssueDraft,
} from "@/feedback/types.js";
import { FileHistory } from "@/file-history/index.js";
import type { Snapshot } from "@/file-history/index.js";
import { GoalManager, handleGoalCommand } from "@/goal/index.js";
import * as historyMod from "@/history/index.js";
import { HookEngine, validate as validateHooks } from "@/hooks/index.js";
import type { LLMClient } from "@/llm/client.js";
import { createClient } from "@/llm/client.js";
import { discoverModels } from "@/llm/model-discovery.js";
import { createChildLogger } from "@/logger/index.js";
import type { LspServerConfig } from "@/lsp/config.js";
import {
  retractMcpInstructions,
  syncMcpInstructions as announceMcpInstructions,
} from "@/mcp/instructions.js";
import { MCPManager, type ConnectResult } from "@/mcp/manager.js";
import { applyMode, decideAndApply } from "@/mcp/strategy.js";
import { MCPToolWrapper } from "@/mcp/tool-wrapper.js";
import { BackgroundMemoryTasks } from "@/memory/background.js";
import { loadInstructions } from "@/memory/instructions.js";
import { MemoryManager, type RecallResult } from "@/memory/manager.js";
import { PermissionChecker, type PermissionMode } from "@/permissions/index.js";
import { getOrCreatePlanPath, planExists } from "@/plan-file/index.js";
import { buildSystemPrompt, detectEnvironment } from "@/prompt/builder.js";
import { buildPlanModeExitReminder } from "@/prompt/plan-mode.js";
import { createSandbox, type Sandbox } from "@/sandbox/index.js";
import * as sessionMod from "@/session/index.js";
import { SkillCatalog, buildSkillSection } from "@/skills/catalog.js";
import { runFork as runSkillFork } from "@/skills/executor.js";
import type { SkillHost, SkillForkHost } from "@/skills/index.js";
import { InstallSkillTool } from "@/skills/install-skill-tool.js";
import { LoadSkillTool } from "@/skills/load-skill-tool.js";
import { AgentTool, type TeammateRunOptions } from "@/subagent/agent-tool.js";
import {
  BUILTIN_AGENTS,
  GENERAL_PURPOSE_AGENT_TYPE,
  SUBAGENT_INTERRUPTED_MARKER,
} from "@/subagent/constants.js";
import { spawnSubagent } from "@/subagent/spawn.js";
import {
  TaskManager,
  formatAgentTaskNotification,
  type AgentTask,
} from "@/subagent/task-manager.js";
import { LEADER_NAME } from "@/teams/constants.js";
import {
  coordinatorToolFilter,
  coordinatorActive,
} from "@/teams/coordinator.js";
import type { RunAgent } from "@/teams/index.js";
import { TeamManager } from "@/teams/index.js";
import { shutdownRequest } from "@/teams/protocol.js";
import { TaskStopTool } from "@/teams/task-stop.js";
import {
  TeamCreateTool,
  SendMessageTool,
  TeamListTool,
  TeamDeleteTool,
} from "@/teams/tools.js";
import { TaskList } from "@/todo/index.js";
import { TaskStore } from "@/todo/store.js";
import { toDisplayPreview } from "@/tool-result/index.js";
import { AskUserQuestionTool, type Question } from "@/tools/ask-user.js";
import { BashTool } from "@/tools/bash.js";
import { FileStateCache } from "@/tools/file-state-cache.js";
import type { ToolRegistry } from "@/tools/registry.js";
import {
  attachBackgroundTaskManager,
  backgroundAllForegroundTasks,
  hasAnyForegroundTasks,
} from "@/tools/shell-background.js";
import { SyntheticOutputTool } from "@/tools/synthetic-output.js";
import type { PermissionRequestHandler } from "@/tools/types.js";
import { AgentActivity } from "@/ui/agent-activity.js";
import { AgentStatus } from "@/ui/agent-status.js";
import { ChatView, type ChatMessage, type ToolSummaryItem } from "@/ui/chat.js";
import { MAX_RECENT_TOOLS, THEME } from "@/ui/constants.js";
import { Footer } from "@/ui/footer.js";
import { InteractionDock } from "@/ui/interaction-dock.js";
import {
  createInterruptHandlers,
  isForegroundBusy,
} from "@/ui/interrupt-scope.js";
import type { IssueApprovalChoice } from "@/ui/issue-approval.js";
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

const log = createChildLogger({ module: "terminal" });

type AppState = "providerSelect" | "chat";

interface Props {
  config?: AppConfig;
  providers: ProviderConfig[];
  permissionMode?: string;
  mcpServers: MCPServerConfig[];
  mcpLoading?: McpLoading;
  lspServers?: LspServerConfig[];
  hooks: HookConfig[];
  sandboxConfig?: SandboxYamlConfig;
  enableCoordinatorMode?: boolean;
  forkDisabled?: boolean;
  /** Auto memory pipeline switch from config.yaml (`enable_memory:`); defaults to true. */
  memoryEnabled?: boolean;
  resume?: true | string;
  onExitSummary?: (summary: InteractionSummary) => void;
  defaultProvider?: number;
}

export function App({
  config: initialConfig,
  providers: initialProviders,
  permissionMode,
  mcpServers,
  mcpLoading = "auto",
  lspServers,
  hooks,
  sandboxConfig: sandboxYaml,
  enableCoordinatorMode,
  forkDisabled,
  memoryEnabled = true,
  resume,
  onExitSummary,
  defaultProvider = 0,
}: Props) {
  const { exit } = useApp();
  const { latestVersionRef, noticeVersion, dismissNotice } = useUpdateNotice();
  const [providers, setProviders] = useState(initialProviders);
  const [loginActive, setLoginActive] = useState(initialProviders.length === 0);
  const rememberedProvider = initialProviders[defaultProvider];
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
  const [permMode, setPermMode] = useState<PermissionMode>(() => {
    const isInitialPermissionMode = (
      mode: string,
    ): mode is Exclude<PermissionMode, "plan"> =>
      ["default", "acceptEdits", "bypassPermissions"].includes(mode);
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
  const surfacedMemoriesRef = useRef<Set<string>>(new Set());
  const permModeRef = useRef(permMode);
  const [mcpInfo, setMcpInfo] = useState<{
    servers: string[];
    toolCount: number;
  } | null>(null);
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  // Bumped when workspace file facts change (file-write tool results, agent run
  // end); the @-mention completion cache in InputBox keys on it.
  const [fileFactsVersion, setFileFactsVersion] = useState(0);

  const cwd = process.cwd();
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
  }, []);

  const clientRef = useRef<LLMClient | null>(null);
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
  const goalManagerRef = useRef<GoalManager | null>(null);
  const currentGoal = (): GoalManager => {
    if (goalManagerRef.current?.sessionId !== sessionIdRef.current) {
      goalManagerRef.current = new GoalManager(cwd, sessionIdRef.current);
    }
    return goalManagerRef.current;
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
    createToolRegistry(cwd, taskListRef.current, {
      interactionMode: "interactive",
      lspServers,
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
  const mcpOperationRef = useRef<Promise<void>>(Promise.resolve());
  // Current MCP server list. Starts as the prop but /mcp reload replaces it
  // with the freshly read config, so consumers must read this ref, not the prop.
  const mcpServersRef = useRef<MCPServerConfig[]>(mcpServers);
  // The MCP load mode is decided once per active client/provider (recomputed on
  // provider switch or login); a later retry pass must reapply that decision
  // rather than recompute it.
  const mcpModeDecidedRef = useRef(false);
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

  // Returns the skills not yet announced to the model and records them in
  // announcedSkillsRef.
  const skillDelta = (): string => {
    const catalog = skillCatalogRef.current;
    if (!catalog) {
      return "";
    }
    const lines: string[] = [];
    for (const meta of catalog.list()) {
      if (announcedSkillsRef.current.has(meta.name)) {
        continue;
      }
      announcedSkillsRef.current.add(meta.name);
      const desc =
        meta.description.length > 200
          ? meta.description.slice(0, 200) + "…"
          : meta.description;
      lines.push(`- /${meta.name}: ${desc}`);
    }
    return lines.join("\n");
  };

  const recoveryStateRef = useRef(new RecoveryState());
  const memoryTasksRef = useRef<BackgroundMemoryTasks | null>(null);
  const memoryCleanupRef = useRef<Promise<void>>(Promise.resolve());
  const stopMemoryTasks = useCallback(async () => {
    const tasks = memoryTasksRef.current;
    memoryTasksRef.current = null;
    memoryCleanupRef.current = Promise.all([
      memoryCleanupRef.current,
      tasks?.dispose(),
    ]).then(() => undefined);
    await memoryCleanupRef.current;
  }, []);
  const memManagerRef = useRef<InstanceType<typeof MemoryManager> | null>(null);
  const activeSkillsRef = useRef(new Map<string, string>());
  const toolFilterRef = useRef<((name: string) => boolean) | null>(null);
  const skillHostRef = useRef<SkillHost>({
    activateSkill: (name, body) => activeSkillsRef.current.set(name, body),
  });
  useEffect(() => {
    if (checkerRef.current) {
      teamManagerRef.current.setPermissionChecker(checkerRef.current);
    }
    // Restore pending notifications and reclaim interrupted teammates' work.
    teamManagerRef.current.restoreFromDisk();
  }, []);
  const [backgroundTaskManager] = useState(
    () => new TaskManager(sessionIdRef.current),
  );
  const backgroundTaskManagerRef = useRef(backgroundTaskManager);
  const fileHistoryRef = useRef<FileHistory | null>(null);
  // The agent instance of the in-flight run, if any. Steering targets it.
  const agentRef = useRef<Agent | null>(null);
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
      void stopMemoryTasks();
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
  const [feedbackActive, setFeedbackActive] = useState(false);
  const [feedbackDescription, setFeedbackDescription] = useState("");
  const [feedbackProgress, setFeedbackProgress] = useState<string | null>(null);
  const [issueApprovalRequest, setIssueApprovalRequest] = useState<
    IssueDraft[] | null
  >(null);
  const issueApprovalResolveRef = useRef<
    ((confirmation: IssueConfirmation) => void) | null
  >(null);
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
    sessionMod.SessionInfo[]
  >([]);
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
  const {
    subagents,
    cardsRef: subagentCardsRef,
    track: trackSubagent,
    prepareTurn: prepareSubagentTurn,
    reset: resetSubagents,
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
  const subagentIdRef = useRef(0);
  const { insertInputTextRef, clearInputRef } = useIdeInput(cwd);

  useEffect(
    () => backgroundTaskManagerRef.current.subscribe(setBackgroundTasks),
    [],
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
        issueApprovalResolveRef,
        setIssueApprovalRequest,
        setPlanApprovalActive,
        permissionQueue: permissionQueueRef,
        backgroundTasks: backgroundTaskManagerRef.current,
        teams: teamManagerRef.current,
      }),
    [],
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
    const memoryStopped = stopMemoryTasks();
    void (async () => {
      interruptAll();
      await userBash.stop();
      // Join the fire-and-forget stopAlls and disconnect MCP before the app
      // unmounts (parity with print-mode/ACP): on Windows the shell kills go
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
    userBash.running || isForegroundBusy(isStreaming, isCompacting, subagents);
  const interruptUserWork = () => {
    if (!userBash.interrupt()) {
      interruptForeground();
    }
  };
  // Single source of truth for "a modal dialog owns the keyboard": global
  // shortcuts belonging to the main chat input stand down while it is true, so
  // individual dialogs (AskUser Other, plan feedback, login, ...) do not each
  // need their own ad-hoc guard.
  const modalActive =
    loginActive ||
    providerDialogActive ||
    modelDialogActive ||
    thinkingDialogActive ||
    planApprovalActive ||
    feedbackActive ||
    issueApprovalRequest !== null ||
    rewindDialogActive ||
    resumeDialogActive ||
    permissionRequest !== null ||
    askRequest !== null ||
    agentsDialogOpen;
  const { toolsExpanded, ctrlCHint } = useTerminalControls({
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
        : isStreaming || userBash.running
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

  const applyMcpResult = useCallback(
    (mgr: MCPManager, provider: ProviderConfig, result: ConnectResult) => {
      for (const { serverName, tool } of result.tools) {
        const client = mgr.getClient(serverName);
        if (client) {
          registryRef.current.register(
            new MCPToolWrapper(client, serverName, tool),
          );
        }
      }
      if (result.errors.length > 0) {
        setMessages((prev) => [
          ...prev,
          {
            role: "system",
            content: `MCP errors: ${result.errors.map((e) => `${e.serverName}: ${e.error}`).join("; ")}`,
          },
        ]);
      }
      setMcpInfo({
        servers: mgr.connectedServers(),
        toolCount: countMcpTools(registryRef.current),
      });
      if (result.tools.length > 0) {
        if (mcpModeDecidedRef.current) {
          // The mode is decided once per client/provider (recomputed on
          // provider switch or login) — re-deciding it on a retry pass could
          // flip tools[] mid-flight and break the cache prefix. Reapply the
          // standing mode so the tools this pass added inherit its defer flag.
          applyMode(registryRef.current, registryRef.current.mcpLoadingMode);
        } else {
          // Only decide the load mode after all tools are registered: it compares total schema size against the context window
          decideAndApply(
            registryRef.current,
            provider.base_url,
            provider.protocol,
            getContextWindow(provider),
            mcpLoading,
          );
          mcpModeDecidedRef.current = true;
        }
      }

      syncMcpInstructions(mgr);
    },
    [mcpLoading, syncMcpInstructions],
  );

  const runMcpOperation = useCallback(
    <T,>(operation: () => Promise<T>): Promise<T> => {
      const result = mcpOperationRef.current.then(operation, operation);
      mcpOperationRef.current = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    [],
  );

  // Connects every configured MCP server that has no live connection yet and
  // registers the tools it reports. Safe to call repeatedly: connectAll skips
  // servers that are already up, so /mcp retries only the ones that failed.
  // Reads the server list from mcpServersRef so /mcp reload takes effect here.
  const connectMcpServers = useCallback(
    (mgr: MCPManager, provider: ProviderConfig) =>
      runMcpOperation(async () => {
        const result = await mgr.connectAll(mcpServersRef.current);
        applyMcpResult(mgr, provider, result);
        return result;
      }),
    [applyMcpResult, runMcpOperation],
  );

  // /mcp reload — re-reads the MCP server list from disk (config.yaml plus the
  // project .mcp.json), disconnects every old server, and connects the fresh list.
  const reloadMcpServers = useCallback(
    () =>
      runMcpOperation(async () => {
        let servers: MCPServerConfig[];
        try {
          servers = withProjectMcpServers(loadConfig(), cwd).mcp_servers;
        } catch (err) {
          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              content: `MCP reload failed: ${asErrorString(err)}`,
            },
          ]);
          return;
        }
        mcpServersRef.current = servers;

        if (servers.length === 0) {
          const previous = mcpManagerRef.current;
          if (previous) {
            await previous.disconnectAll();
            syncMcpInstructions(previous);
          }
          removeMcpTools(registryRef.current);
          mcpManagerRef.current = null;
          setMcpInfo({ servers: [], toolCount: 0 });
          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              content: "MCP config reloaded: no MCP servers are configured.",
            },
          ]);
          return;
        }

        const mgr = mcpManagerRef.current ?? new MCPManager();
        mcpManagerRef.current = mgr;
        setMessages((prev) => [
          ...prev,
          {
            role: "system",
            content: `Reloading MCP server(s): ${servers.map((s) => s.name).join(", ")}`,
          },
        ]);
        removeMcpTools(registryRef.current);
        retractMcpInstructions(
          conversationRef.current,
          announcedMcpServersRef.current,
        );
        const result = await mgr.reconnectAll(servers);
        applyMcpResult(mgr, selectedProviderRef.current, result);
        setMessages((prev) => [
          ...prev,
          {
            role: "system",
            content:
              `MCP reloaded: ${String(mgr.connectedServers().length)} server(s) connected, ` +
              `${String(countMcpTools(registryRef.current))} tool(s)`,
          },
        ]);
      }),
    [cwd, applyMcpResult, runMcpOperation, syncMcpInstructions],
  );

  const initClient = useCallback(
    async (provider: ProviderConfig) => {
      try {
        const hookErr = validateHooks(hooks);
        if (hookErr) {
          throw hookErr;
        }

        const env = detectEnvironment(cwd);
        env.model = provider.model;
        const systemPrompt = buildSystemPrompt(env);
        const client = await createClient(provider, systemPrompt);
        await stopMemoryTasks();
        clientRef.current = client;

        contextWindowRef.current = getContextWindow(provider);
        maxOutputRef.current = getMaxOutputTokens(provider);

        fileHistoryRef.current = new FileHistory(sessionIdRef.current);

        historyMod.registerProject(cwd);
        const instructions = loadInstructions(cwd);
        // enable_memory: false disables the whole auto-memory pipeline; no
        // manager is created so nothing scans, rebuilds MEMORY.md, or injects
        // reminders.
        const memMgr = memoryEnabled ? new MemoryManager(cwd) : null;
        memManagerRef.current = memMgr;
        const memReminder = memMgr?.buildSystemReminder() ?? "";
        conversationRef.current.injectLongTermMemory(instructions, memReminder);

        setPromptHistory(historyMod.loadInputTexts());

        hookEngineRef.current = new HookEngine(hooks);

        const catalog = new SkillCatalog();
        catalog.load(cwd);
        skillCatalogRef.current = catalog;

        // The skill catalog is project-scoped and never baked into the system
        // prompt; the Agent injects it via the first system-reminder, and
        // skills added mid-session are appended by skillDelta.

        registryRef.current.register(
          new LoadSkillTool(catalog, skillHostRef.current),
        );
        // Register InstallSkill so the model can install skills from a path/URL.
        // The onInstalled callback re-wires skills→commands so a freshly-fetched
        // skill is immediately available as /<name> without a UI restart.
        registryRef.current.register(
          new InstallSkillTool(cwd, catalog, () => {
            // Only rewire the slash commands; leave the system prompt alone.
            // Newly installed skills are delivered by skillDelta as a
            // system-reminder on the next turn.
            wireSkillsToRegistry(
              catalog,
              cmdRegistryRef.current,
              skillHostRef.current,
            );
          }),
        );

        registryRef.current.register(
          new AskUserQuestionTool(
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
          ),
        );

        // Register team coordination tools. Teammates run as background
        // general-purpose subagents whose results return via the team channel.
        // backgroundTasks:false — a teammate loop is one spawnSubagent run per
        // task turn, so a per-run manager's turn-end stopAll() would kill
        // anything the teammate backgrounded; teammates stay purely foreground.
        // RunAgent factory for teammates: runs the teammate agent main loop
        // against the teammate-scoped registry (shared task-board tools are
        // already injected by AgentTool before this factory is called).
        const teamRunAgentFactory = (
          registry: ToolRegistry,
          teamChecker?: PermissionChecker,
          memberCwd = cwd,
          options?: TeammateRunOptions,
        ): RunAgent => {
          const conversation = new ConversationManager();
          return (task, onEvent, abortSignal) =>
            spawnSubagent(
              options?.definition ?? BUILTIN_AGENTS[0],
              task,
              clientRef.current ?? client,
              registry,
              selectedProviderRef.current,
              memberCwd,
              undefined,
              onEvent,
              options?.modelOverride,
              teamChecker,
              {
                abortSignal,
                backgroundTasks: false,
                contextSnapshot: options?.contextSnapshot,
                agentName: options?.agentName,
                conversation,
                onPermissionRequest: requestPermission,
              },
            );
        };
        registryRef.current.register(
          new TeamCreateTool(teamManagerRef.current),
        );
        registryRef.current.register(
          new SendMessageTool(teamManagerRef.current),
        );
        registryRef.current.register(new TeamListTool(teamManagerRef.current));
        registryRef.current.register(
          new TeamDeleteTool(teamManagerRef.current),
        );
        registryRef.current.register(
          new TaskStopTool(
            teamManagerRef.current,
            backgroundTaskManagerRef.current,
          ),
        );
        registryRef.current.register(new SyntheticOutputTool());

        // Share the background task registry with Bash/PowerShell so
        // run_in_background, Ctrl+B backgrounding and timeout auto-background
        // deliver results through the same task-notification drain as
        // background agents.
        attachBackgroundTaskManager(
          registryRef.current,
          backgroundTaskManagerRef.current,
        );

        // Load user-defined slash commands from ~/.yukino/prompts/*.md
        // (global user home only; there is no project-level prompt source).
        for (const cmd of loadUserCommands()) {
          try {
            cmdRegistryRef.current.register(cmd);
          } catch {
            // name clash with a built-in command → keep the built-in
          }
        }

        // Wire every loaded skill as a slash command (inline → "prompt",
        // fork → "skill_fork"). Runs after user commands so user *.md files
        // take precedence. Idempotent: skips names already taken.
        wireSkillsToRegistry(
          catalog,
          cmdRegistryRef.current,
          skillHostRef.current,
        );

        const agentTool = new AgentTool(
          cwd,
          registryRef.current,
          (
            def,
            prompt,
            background,
            modelOverride?,
            cwdOverride?,
            context?,
            contextSnapshot?,
          ) => {
            const toolCallId =
              context?.toolCallId ??
              `subagent-${String(++subagentIdRef.current)}`;
            return trackSubagent(
              {
                toolCallId,
                role: def.name,
                taskId: context?.backgroundTaskId,
                abortSignal: context?.abortSignal,
              },
              (onEvent) =>
                spawnSubagent(
                  def,
                  prompt,
                  clientRef.current ?? client,
                  registryRef.current,
                  selectedProviderRef.current,
                  cwdOverride ?? cwd,
                  undefined,
                  onEvent,
                  modelOverride,
                  cwdOverride
                    ? context?.permissionChecker?.forCwd(cwdOverride)
                    : context?.permissionChecker,
                  {
                    sessionId: context?.subagentSessionId,
                    contextSnapshot,
                    abortSignal: context?.abortSignal,
                    background,
                    onPermissionRequest: context?.onPermissionRequest,
                    permissionMode: context?.permissionChecker?.mode,
                  },
                ),
            );
          },
          conversationRef.current,
          backgroundTaskManagerRef.current,
        );
        agentTool.defaultFork = !(forkDisabled ?? false);
        // Wire the team manager into AgentTool to enable the teammate path (teammates receive shared task-board tools)
        agentTool.setTeamManager(teamManagerRef.current, teamRunAgentFactory);
        registryRef.current.register(agentTool);

        if (mcpServers.length > 0) {
          const mgr = new MCPManager();
          mcpManagerRef.current = mgr;
          void connectMcpServers(mgr, provider);
        }
      } catch (err) {
        setError(`Failed to initialize agent: ${asErrorString(err)}`);
      }
    },
    [
      cwd,
      mcpServers,
      connectMcpServers,
      memoryEnabled,
      hooks,
      forkDisabled,
      trackSubagent,
    ],
  );

  useEffect(() => {
    if (appState === "chat" && !clientRef.current) {
      void initClient(selectedProvider);
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
        const environment = detectEnvironment(cwd);
        environment.model = provider.model;
        const client = await createClient(
          provider,
          buildSystemPrompt(environment),
        );
        await stopMemoryTasks();
        clientRef.current = client;
        selectedProviderRef.current = provider;
        setSelectedProvider(provider);
        rememberProvider(provider, list);
        contextWindowRef.current = getContextWindow(provider);
        maxOutputRef.current = getMaxOutputTokens(provider);
        decideAndApply(
          registryRef.current,
          provider.base_url,
          provider.protocol,
          contextWindowRef.current,
          mcpLoading,
        );
        setMessages((current) => [
          ...current,
          {
            role: "system",
            content: `Provider switched to ${provider.name} · ${provider.model}.`,
          },
        ]);
      } catch (err) {
        selectedProviderRef.current = previousProvider;
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
    const updated = { ...provider, model: nextModel };
    setProviderSwitching(true);
    try {
      const environment = detectEnvironment(cwd);
      environment.model = updated.model;
      const client = await createClient(
        updated,
        buildSystemPrompt(environment),
      );
      await stopMemoryTasks();
      clientRef.current = client;
      selectedProviderRef.current = updated;
      setSelectedProvider(updated);
      setProviders((current) =>
        current.map((entry) =>
          entry.base_url === updated.base_url
            ? { ...entry, model: updated.model }
            : entry,
        ),
      );
      contextWindowRef.current = getContextWindow(updated);
      maxOutputRef.current = getMaxOutputTokens(updated);
      decideAndApply(
        registryRef.current,
        updated.base_url,
        updated.protocol,
        contextWindowRef.current,
        mcpLoading,
      );
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

    // /mcp — show MCP server status, first retrying any server still not
    // connected; /mcp reload re-reads the config from disk and reconnects it.
    if (parsed.name === "mcp") {
      if (!submittedInput) {
        recordCliInput(text, "mcp");
      }
      if (parsed.args.trim().toLowerCase() === "reload") {
        await reloadMcpServers();
        return true;
      }
      const mgr = mcpManagerRef.current;
      if (!mgr) {
        setMessages((prev) => [
          ...prev,
          { role: "system", content: "No MCP servers configured." },
        ]);
        return true;
      }
      const down = mgr.missingServers(mcpServersRef.current);
      if (down.length > 0) {
        setMessages((prev) => [
          ...prev,
          {
            role: "system",
            content: `Connecting MCP server(s): ${down.join(", ")}`,
          },
        ]);
        await connectMcpServers(mgr, selectedProvider);
      }
      const connected = mgr.connectedServers();
      const stillDown = mgr.missingServers(mcpServersRef.current);
      const lines =
        connected.length === 0
          ? ["No MCP servers connected."]
          : [
              `MCP servers (${String(connected.length)}):`,
              ...connected.map((s) => `  · ${s}`),
              `Tools: ${String(countMcpTools(registryRef.current))} total`,
            ];
      if (stillDown.length > 0) {
        lines.push(`Not connected: ${stillDown.join(", ")}`);
      }
      setMessages((prev) => [
        ...prev,
        { role: "system", content: lines.join("\n") },
      ]);
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
        `Tokens:    ${String(inputTokens)} in / ${String(outputTokens)} out`,
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
              { role: "system", content: "Client not ready." },
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
          const instructions = loadInstructions(cwd);
          const memory = memManagerRef.current?.buildSystemReminder() ?? "";
          const sessionId = sessionMod.newSessionId();
          const fileHistory = new FileHistory(sessionId);
          await Promise.all([
            backgroundTaskManagerRef.current.stopAll(),
            teamManagerRef.current.stopAll(),
          ]);
          await stopMemoryTasks();
          backgroundTaskManagerRef.current.useSession(sessionId);
          taskListRef.current.useStore(new TaskStore(sessionId));
          backgroundTaskManagerRef.current.clear();
          resetSubagents();
          // Clear messages and start a fresh conversation. Reset in place —
          // AgentTool captures the manager for its fork path, so swapping the
          // instance would leave it pointing at the discarded history.
          setMessages([]);
          conversationRef.current.reset();
          // A fresh conversation must not inherit the previous session's
          // read-before-edit state.
          fileStateCacheRef.current.clear();
          // ...nor the old session's queued follow-ups and steering history.
          followUpResetRef.current();
          announcedSkillsRef.current.clear();
          conversationRef.current.injectLongTermMemory(instructions, memory);
          // The fresh history holds no MCP announcement any more, so this re-sends
          // the instructions of every connected server.
          if (mcpManagerRef.current) {
            syncMcpInstructions(mcpManagerRef.current);
          }
          // Reset the session ID and the stores derived from it
          sessionIdRef.current = sessionId;
          planOwner().planFilePath = "";
          interactionStatsRef.current = {
            agentActiveMs: 0,
            failedToolCalls: 0,
            startedAt: Date.now(),
            successfulToolCalls: 0,
            toolTimeMs: 0,
          };
          activeToolIdsRef.current.clear();
          activeToolBatchStartedAtRef.current = null;
          fileHistoryRef.current = fileHistory;
          output.resetUsage();
          // Reset memory extraction, recall and compact-recovery state
          recentToolsRef.current = [];
          surfacedMemoriesRef.current.clear();
          recoveryStateRef.current = new RecoveryState();
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
        case "feedback":
          setFeedbackDescription(parsed.args);
          setFeedbackActive(true);
          break;
        case "resume": {
          const arg = parsed.args.trim();
          if (!arg) {
            const sessions = sessionMod
              .listSessions(cwd)
              .filter((session) => session.messageCount > 0);
            if (sessions.length === 0) {
              setMessages((prev) => [
                ...prev,
                { role: "system", content: "No sessions found." },
              ]);
            } else {
              setResumeSessions(sessions);
              setResumeDialogActive(true);
            }
            break;
          }

          const saved = sessionMod.loadSessionForResume(cwd, arg);
          if (saved.length === 0) {
            const sessions = sessionMod
              .listSessions(cwd)
              .filter((session) => session.messageCount > 0);
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: `Session "${arg}" not found or empty.`,
              },
            ]);
            if (sessions.length > 0) {
              setResumeSessions(sessions);
              setResumeDialogActive(true);
            }
            break;
          }

          // Rebuild the conversation (with long-term memory re-injected) and the
          // visible transcript from the saved messages, then continue under the
          // resumed session id. rebuildFromSession honors compaction: if the
          // session contains a compact_boundary it replays the compacted state
          // (summary + inlined keep + post-boundary appends) instead of the full
          // pre-boundary history; with no boundary it replays everything.
          const instructions = loadInstructions(cwd);
          const memory = memoryEnabled
            ? new MemoryManager(cwd).buildSystemReminder()
            : "";
          const restored = sessionMod.rebuildFromSession(saved);
          const fileHistory = new FileHistory(arg);
          await backgroundTaskManagerRef.current.stopAll();
          await stopMemoryTasks();
          taskListRef.current.useStore(new TaskStore(arg));
          backgroundTaskManagerRef.current.useSession(arg);
          resetSubagents();
          const conv = conversationRef.current;
          conv.reset();
          // Resumed baseline: files read in the old/other session are not
          // "already read" for this one.
          fileStateCacheRef.current.clear();
          // Drop follow-ups/steering recorded against the previous conversation.
          followUpResetRef.current();
          conv.injectLongTermMemory(instructions, memory);
          conv.appendMessages(
            restored.map((message) => ({
              ...message,
              toolUses: message.toolUses?.map((tool) => ({
                ...tool,
                arguments: tool.arguments ?? {},
              })),
            })),
          );
          announcedMcpServersRef.current.clear();
          if (mcpManagerRef.current) {
            syncMcpInstructions(mcpManagerRef.current);
          }
          announcedSkillsRef.current.clear();
          sessionIdRef.current = arg;
          goalManagerRef.current = null;
          planOwner().planFilePath = "";
          setResumeDialogActive(false);
          setResumeSessions([]);
          recentToolsRef.current = [];
          surfacedMemoriesRef.current.clear();
          recoveryStateRef.current = new RecoveryState();
          // Re-key file history to the resumed session. Snapshots persist per
          // session and are reloaded on construction; /rewind after a resume
          // truncates the session log at the snapshot's recorded line count and
          // rebuilds the conversation from it, so stale in-memory message
          // indexes from the previous process are never trusted.
          fileHistoryRef.current = fileHistory;
          const resumedMessages = transcriptFromRestored(
            sessionMod.rebuildFromSession(saved, {
              includeExcludedUserBash: true,
            }),
          );
          resumedMessages.push({
            role: "system",
            content: `⟲ Resumed session ${arg} (${String(restored.length)} messages).`,
          });
          setMessages(resumedMessages);
          dismissNotice();
          setTranscriptRevision((revision) => revision + 1);
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
            const { execSync } = await import("node:child_process");
            const output = execSync("git worktree list", {
              cwd: cwd,
              encoding: "utf-8",
            });
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
              client.setThinkingLevel?.(level);
              const updated = {
                ...selectedProviderRef.current,
                thinking: client.getThinkingLevel?.() ?? level,
              };
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
          if (cmd.agent === "plan" && !result.isError) {
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
          { role: "system", content: "Client not ready." },
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
    const recallPromise =
      memManagerRef.current && clientRef.current
        ? memManagerRef.current
            .findRelevantMemories(
              contentToText(
                conversationRef.current
                  .getMessages()
                  .filter((m) => m.role === "user")
                  .pop()?.content ?? "",
              ),
              clientRef.current,
              [...recentToolsRef.current],
              new Set(surfacedMemoriesRef.current),
              controller.signal,
            )
            .then((memories): RecallResult => {
              // Only select and render here; the selected paths travel with the result
              // to the agent, which records them as surfaced upon actual injection
              const reminder =
                memManagerRef.current?.renderReminder(memories) ?? "";
              return { reminder, paths: memories.map((m) => m.path) };
            })
            .catch((): RecallResult => ({ reminder: "", paths: [] }))
        : undefined;

    if (!clientRef.current) {
      return;
    }

    const agent = new Agent({
      client: clientRef.current,
      registry: registryRef.current,
      checker,
      conversation: conversationRef.current,
      cwd,
      sessionId: sessionIdRef.current,
      goalManager: currentGoal(),
      shouldContinueGoal: () => !followUps.hasPending(),
      hookEngine: hookEngineRef.current ?? undefined,
      fileHistory: fileHistoryRef.current ?? undefined,
      fileStateCache: fileStateCacheRef.current,
      abortSignal: controller.signal,
      contextWindow: contextWindowRef.current,
      maxOutput: maxOutputRef.current,
      recoveryState: recoveryStateRef.current,
      activeSkills: activeSkillsRef.current,
      instructions: loadInstructions(cwd),
      memoryContent: memManagerRef.current?.buildSystemReminder() ?? "",
      skillSection: skillCatalogRef.current
        ? buildSkillSection(skillCatalogRef.current)
        : "",
      skillDeltaFn: skillDelta,
      memoryRecallPromise: recallPromise,
      onMemoriesSurfaced: (paths) => {
        for (const path of paths) {
          surfacedMemoriesRef.current.add(path);
        }
      },
      toolFilter: buildComposedToolFilter(
        coordinatorToolFilter(enableCoordinatorMode ?? false),
        toolFilterRef.current,
      ),
      coordinatorActiveFn: () =>
        coordinatorActive(enableCoordinatorMode ?? false),
      // Surface teammate and background Agent results as reminders.
      notificationFn: () => [
        ...teamManagerRef.current.drainLeaderMailbox(),
        ...backgroundTaskManagerRef.current
          .drainNotifications()
          .map(formatAgentTaskNotification),
      ],
      onLoopComplete: (conv) => {
        const client = clientRef.current;
        if (!client || !memoryEnabled || exitingRef.current) {
          return;
        }
        memoryTasksRef.current ??= new BackgroundMemoryTasks(client, cwd, {
          onSaved: (saved) => {
            setMessages((current) => [
              ...current,
              { role: "system", content: `Memory saved: ${saved.join(", ")}` },
            ]);
          },
          appendSystem: (message) => {
            setMessages((current) => [
              ...current,
              { role: "system", content: message },
            ]);
          },
        });
        memoryTasksRef.current.run(conv);
      },
      onPermissionRequest: requestPermission,
    });

    agentRef.current = agent;
    let exitPlanSucceeded = false;

    try {
      for await (const event of agent.run()) {
        onAgentEvent(event);
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
      const leftover = agent.drainSteering();
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
    if (!clientRef.current) {
      setError("LLM client not ready yet");
      return;
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
          handleSubmit(`Execute this plan:\n\n${planContent}`);
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
          handleSubmit(`Execute this plan:\n\n${planContent}`);
        }
      } else if (choice === "feedback" && feedback) {
        handleSubmit(feedback);
      }
    },
    [cwd],
  );

  /**
   * Rewind the live conversation to a snapshot, persisting the rewind.
   *
   * The snapshot's sessionLineCount is the authoritative coordinate: the
   * session log is truncated to it and the in-memory conversation is rebuilt
   * from the truncated log. Line coordinates survive resume and compaction,
   * unlike in-memory message indexes (which are only meaningful within the
   * process that captured them). Snapshots with no recorded sessionLineCount
   * — or whose session file is gone — fall back to truncating by messageIndex.
   *
   * Returns the visible transcript for the rewound state: the caller must
   * rebuild the displayed messages too, or the UI would keep showing
   * messages the conversation no longer holds.
   */
  const rewindConversation = (snap: Snapshot): ChatMessage[] => {
    const sessionFilePath = sessionMod.getSessionFilePath(
      cwd,
      sessionIdRef.current,
    );
    if (snap.sessionLineCount !== undefined && existsSync(sessionFilePath)) {
      sessionMod.truncateSessionLines(sessionFilePath, snap.sessionLineCount);
      const saved = sessionMod.loadSession(cwd, sessionIdRef.current);
      const rebuilt = sessionMod.rebuildFromSession(saved);
      conversationRef.current.reset();
      conversationRef.current.appendMessages(rebuilt);
      goalManagerRef.current = null;
      return transcriptFromRestored(
        sessionMod.rebuildFromSession(saved, {
          includeExcludedUserBash: true,
        }),
      );
    }
    conversationRef.current.truncateTo(snap.messageIndex);
    return transcriptFromRestored(
      conversationRef.current
        .getMessages()
        .filter(
          (message) =>
            message.role !== "system" &&
            !contentToText(message.content).startsWith("<system-reminder>"),
        ),
    );
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
            const changed = fh.rewind(action.snapshotIndex);
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
            const changed = fh.rewind(action.snapshotIndex);
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
    await runUserTurn(text, input ?? recordCliInput(text));
  };

  const turnBlocked =
    exitingRef.current ||
    appState !== "chat" ||
    !clientRef.current ||
    isStreaming ||
    userBash.running ||
    isCompacting ||
    providerSwitching ||
    loginActive ||
    providerDialogActive ||
    modelDialogActive ||
    thinkingDialogActive ||
    planApprovalActive ||
    feedbackActive ||
    issueApprovalRequest !== null ||
    rewindDialogActive ||
    resumeDialogActive ||
    permissionRequest !== null ||
    askRequest !== null ||
    agentsDialogOpen;
  const followUps = useFollowUpQueue({
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
  const handleSubmit = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    dismissNotice();
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
      return;
    }
    if (isStreaming && !trimmed.startsWith("/") && agentRef.current) {
      const input = recordCliInput(trimmed);
      agentRef.current.steer(trimmed, input);
      setSteeringPending((prev) => [...prev, input]);
      return;
    }
    followUps.enqueue(text);
  };

  const handleComposerSubmit = (text: string): boolean | undefined => {
    const shellSubmission = userBash.submit(text);
    if (shellSubmission !== undefined) {
      return shellSubmission;
    }
    handleSubmit(text);
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

  const handleFeedbackSubmit = (options: FeedbackOptions): void => {
    setFeedbackActive(false);
    const client = clientRef.current;
    if (!client) {
      setMessages((prev) => [
        ...prev,
        { role: "system", content: "Client not ready." },
      ]);
      return;
    }

    dismissNotice();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsStreaming(true);
    prepareSubagentTurn();
    const provider = selectedProviderRef.current;
    const sessionId = sessionIdRef.current;

    let rejection: PipelineResult["rejection"] | undefined;
    void runFeedbackPipeline(options, {
      cwd,
      sessionId,
      runAgent: async (prompt) => {
        const agent = registryRef.current.get("Agent");
        if (!(agent instanceof AgentTool)) {
          throw new Error("The built-in feedback agent is unavailable.");
        }
        const result = await agent.runBuiltin(
          GENERAL_PURPOSE_AGENT_TYPE,
          {
            cwd,
            permissionChecker: checkerRef.current ?? undefined,
            abortSignal: controller.signal,
            onPermissionRequest: requestPermission,
          },
          prompt,
        );
        controller.signal.throwIfAborted();
        if (
          result.isError ||
          result.output.includes(SUBAGENT_INTERRUPTED_MARKER)
        ) {
          throw new Error(result.output);
        }
        return result.output;
      },
      messages: conversationRef.current.getMessages(),
      runtime: {
        config: {
          ...initialConfig,
          providers,
          active_provider: {
            ...provider,
            context_window: contextWindowRef.current,
            max_output_tokens: maxOutputRef.current,
            thinking: client.getThinkingLevel?.() ?? provider.thinking,
          },
          permission_mode: permModeRef.current,
          mcp_servers: mcpServersRef.current,
          lsp_servers: lspServers,
          hooks,
          sandbox: {
            ...sandboxYaml,
            enabled: sandboxEnabledRef.current,
            auto_allow: sandboxAutoAllowRef.current,
          },
          enable_coordinator_mode: enableCoordinatorMode,
          enable_fork: !forkDisabled,
          enable_memory: memoryEnabled,
        },
        provider: {
          name: provider.name,
          model: provider.model,
          protocol: provider.protocol,
          baseUrl: provider.base_url,
          contextWindow: contextWindowRef.current,
          maxOutputTokens: maxOutputRef.current,
          thinkingLevel: client.getThinkingLevel?.() ?? provider.thinking,
        },
        permissionMode: permModeRef.current,
        sandbox: {
          enabled: sandboxEnabledRef.current,
          autoAllow: sandboxAutoAllowRef.current,
        },
        mcpServers: mcpManagerRef.current?.connectedServers(),
        toolCount: registryRef.current.listTools().length,
        sessionId,
      },
      contextWindow: contextWindowRef.current,
      abortSignal: controller.signal,
      onProgress: setFeedbackProgress,
      confirmIssues: (issues) =>
        new Promise<IssueConfirmation>((resolve) => {
          setMessages((prev) => [
            ...prev,
            ...issues.map((issue, index) => ({
              role: "system" as const,
              content: `Issue ${String(index + 1)}/${String(issues.length)}: ${issue.title}\n\n${issue.body}`,
            })),
          ]);
          issueApprovalResolveRef.current = resolve;
          setIssueApprovalRequest(issues);
        }),
    })
      .then((result) => {
        rejection = result.rejection;
        setMessages((prev) => [
          ...prev,
          { role: "system", content: result.report },
        ]);
      })
      .catch((err: unknown) => {
        const message = controller.signal.aborted
          ? "Feedback cancelled."
          : `Feedback failed: ${asErrorString(err)}`;
        setMessages((prev) => [...prev, { role: "system", content: message }]);
      })
      .finally(() => {
        setFeedbackProgress(null);
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        setIsStreaming(false);
        // Mirror the plan-approval feedback path: the rejection reason goes
        // to the agent as a user turn, with the rejected titles as context.
        const reason = rejection?.reason;
        if (reason) {
          const titles = (rejection?.issues ?? [])
            .map((issue) => `- ${issue.title}`)
            .join("\n");
          conversationRef.current.addSystemReminder(
            `<feedback_issue_rejection>\nThe user rejected filing these /feedback issues and asked you not to re-file them:\n${titles}\n</feedback_issue_rejection>`,
          );
          handleSubmit(
            `Feedback on the rejected /feedback issues:\n\n${reason}`,
          );
        }
      });
  };

  const handleIssueApproval = (
    choice: IssueApprovalChoice,
    reason?: string,
  ): void => {
    setIssueApprovalRequest(null);
    const resolve = issueApprovalResolveRef.current;
    issueApprovalResolveRef.current = null;
    resolve?.({ approved: choice === "approve", reason });
  };

  const handleLogin = async (input: ProviderConfig): Promise<void> => {
    const environment = detectEnvironment(cwd);
    environment.model = input.model;
    // Construct before saving so invalid client configuration leaves the form editable.
    const client = await createClient(input, buildSystemPrompt(environment));
    const saved = saveProvider(input, providers);
    setProviders(saved.providers);
    setError("");
    if (clientRef.current) {
      await stopMemoryTasks();
      clientRef.current = client;
      selectedProviderRef.current = saved.provider;
      setSelectedProvider(saved.provider);
      rememberProvider(saved.provider, saved.providers);
      contextWindowRef.current = getContextWindow(saved.provider);
      maxOutputRef.current = getMaxOutputTokens(saved.provider);
      decideAndApply(
        registryRef.current,
        saved.provider.base_url,
        saved.provider.protocol,
        contextWindowRef.current,
        mcpLoading,
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
          {feedbackProgress && !issueApprovalRequest ? (
            <Box paddingLeft={1}>
              <Text color={THEME.muted} wrap="truncate-end">
                {feedbackProgress}
              </Text>
            </Box>
          ) : null}
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
          feedback={
            feedbackActive
              ? {
                  cwd,
                  sessionId: sessionIdRef.current,
                  description: feedbackDescription,
                  onSubmit: handleFeedbackSubmit,
                  onCancel: () => {
                    setFeedbackActive(false);
                  },
                }
              : undefined
          }
          issueApproval={
            issueApprovalRequest
              ? {
                  issues: issueApprovalRequest,
                  onSelect: handleIssueApproval,
                }
              : undefined
          }
          resume={
            resumeDialogActive
              ? {
                  sessions: resumeSessions,
                  currentSessionId: sessionIdRef.current,
                  onCancel: () => {
                    setResumeDialogActive(false);
                  },
                  onSelect: (sessionId) => {
                    void handleSlashCommand(`/resume ${sessionId}`);
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
              ? "Error"
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
  );
}
