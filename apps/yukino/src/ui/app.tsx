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

import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { Box, Text, useApp } from "ink";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";

import { AgentActivity, type SubagentProgress } from "./agent-activity.js";
import { ChatView, type ChatMessage, type ToolSummaryItem } from "./chat.js";
import { Footer } from "./footer.js";
import { InteractionDock } from "./interaction-dock.js";
import {
  createInterruptHandlers,
  isForegroundBusy,
} from "./interrupt-scope.js";
import type { ModelPickerState } from "./model-select.js";
import { PendingQueue } from "./pending-queue.js";
import type { PlanChoice } from "./plan-approval.js";
import { ProviderLogin } from "./provider-login.js";
import { ProviderSelect } from "./provider-select.js";
import type { RewindAction } from "./rewind-dialog.js";
import { TeamStatus } from "./team-status.js";
import { Transcript } from "./transcript.js";
import {
  useAgentOutput,
  type AgentCardDecoration,
} from "./use-agent-output.js";
import { useTerminalControls } from "./use-terminal-controls.js";

import { Agent } from "@/agent/index.js";
import type { InteractionSummary } from "@/bootstrap/interaction-summary.js";
import {
  buildComposedToolFilter,
  countMcpTools,
  createToolRegistry,
  removeMcpTools,
  wireSkillsToRegistry,
} from "@/bootstrap/tool-registry.js";
import type { CodeReviewFormOptions } from "@/code-review/form.js";
import { formatReviewReport } from "@/code-review/report.js";
import { runCodeReview } from "@/code-review/runner.js";
import {
  parse as parseCommand,
  createDefaultRegistry as createCommandRegistry,
} from "@/commands/commands.js";
import { loadUserCommands } from "@/commands/loader.js";
import { CommandUsageTracker } from "@/commands/usage-tracker.js";
import { currentContextTokens, forceCompact } from "@/compact/compact.js";
import { RecoveryState } from "@/compact/recovery.js";
import type {
  MCPServerConfig,
  HookConfig,
  SandboxYamlConfig,
} from "@/config/index.js";
import { loadConfig, withProjectMcpServers } from "@/config/index.js";
import type { ProviderConfig } from "@/config/provider-config.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_THINKING_LEVEL,
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
import { ConversationManager } from "@/conversation/index.js";
import { FileHistory } from "@/file-history/index.js";
import type { Snapshot } from "@/file-history/index.js";
import * as historyMod from "@/history/index.js";
import { HookEngine, validate as validateHooks } from "@/hooks/index.js";
import type { LLMClient } from "@/llm/client.js";
import { createClient } from "@/llm/client.js";
import { discoverModels } from "@/llm/model-discovery.js";
import { createChildLogger } from "@/logger/index.js";
import { syncMcpInstructions as announceMcpInstructions } from "@/mcp/instructions.js";
import { MCPManager, type ConnectResult } from "@/mcp/manager.js";
import { applyMode, decideAndApply } from "@/mcp/strategy.js";
import { MCPToolWrapper } from "@/mcp/tool-wrapper.js";
import { MemoryExtractor } from "@/memory/extractor.js";
import { loadInstructions } from "@/memory/instructions.js";
import { MemoryManager, type RecallResult } from "@/memory/manager.js";
import { PermissionChecker, type PermissionMode } from "@/permissions/index.js";
import { getOrCreatePlanPath, planExists } from "@/plan-file/index.js";
import { buildSystemPrompt, detectEnvironment } from "@/prompt/builder.js";
import {
  buildPlanModeExitReminder,
  buildPlanModeReentryReminder,
} from "@/prompt/plan-mode.js";
import { createSandbox, type Sandbox } from "@/sandbox/index.js";
import * as sessionMod from "@/session/index.js";
import { SkillCatalog, buildSkillSection } from "@/skills/catalog.js";
import { runFork as runSkillFork } from "@/skills/executor.js";
import type { SkillHost, SkillForkHost } from "@/skills/index.js";
import { InstallSkillTool } from "@/skills/install-skill-tool.js";
import { LoadSkillTool } from "@/skills/load-skill-tool.js";
import { AgentTool } from "@/subagent/agent-tool.js";
import { BUILTIN_AGENTS } from "@/subagent/definition.js";
import {
  spawnSubagent,
  SUBAGENT_INTERRUPTED_MARKER,
  type AgentEventSink,
} from "@/subagent/spawn.js";
import {
  TaskManager,
  formatAgentTaskNotification,
  type AgentTask,
} from "@/subagent/task-manager.js";
import {
  coordinatorToolFilter,
  coordinatorActive,
} from "@/teams/coordinator.js";
import type { RunAgent } from "@/teams/index.js";
import { TeamManager } from "@/teams/index.js";
import { LEADER_NAME, SHUTDOWN_PREFIX } from "@/teams/protocol.js";
import { TaskStopTool } from "@/teams/task-stop.js";
import {
  TeamCreateTool,
  SpawnTeammateTool,
  SendMessageTool,
  ListTeamsTool,
  TeamDeleteTool,
} from "@/teams/tools.js";
import { TaskList } from "@/todo/index.js";
import { TaskStore } from "@/todo/store.js";
import { toDisplayPreview } from "@/tool-result/index.js";
import { AskUserQuestionTool, type Question } from "@/tools/ask-user.js";
import { BashTool } from "@/tools/bash.js";
import { ExitPlanModeTool } from "@/tools/exit-plan-mode.js";
import { FileStateCache } from "@/tools/file-state-cache.js";
import type { ToolRegistry } from "@/tools/registry.js";
import {
  attachBackgroundTaskManager,
  backgroundAllForegroundTasks,
  hasAnyForegroundTasks,
} from "@/tools/shell-background.js";
import { SyntheticOutputTool } from "@/tools/synthetic-output.js";
import { activityStatusColor, THEME, thinkingLevelColor } from "@/ui/styles.js";
import { useFollowUpQueue } from "@/ui/use-follow-up-queue.js";
import { useIdeInput } from "@/ui/use-ide-input.js";
import { useNotificationWakeup } from "@/ui/use-notification-wakeup.js";
import { useTeammateStates } from "@/ui/use-teammate-states.js";
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
  providers: ProviderConfig[];
  permissionMode?: string;
  mcpServers: MCPServerConfig[];
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

// Maximum number of recent tool names (deduplicated) passed to the memory recall selector
const MAX_RECENT_TOOLS = 10;

export function App({
  providers: initialProviders,
  permissionMode,
  mcpServers,
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
  const [codeReviewActive, setCodeReviewActive] = useState(false);
  const [thinkingDialogActive, setThinkingDialogActive] = useState(false);
  const [providerSwitching, setProviderSwitching] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const output = useAgentOutput(setMessages);
  const {
    streamingText,
    streamingThinking,
    streamingTextRef,
    activeTools,
    persistentAgentTools,
    inputTokens,
    outputTokens,
  } = output;
  const [isStreaming, setIsStreaming] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [permMode, setPermMode] = useState<PermissionMode>(() => {
    if (process.env.YUKINO_BYPASS_PERMISSIONS === "1") {
      return "bypassPermissions";
    }
    const isPermissionMode = (mode: string): mode is PermissionMode =>
      ["default", "acceptEdits", "plan", "bypassPermissions"].includes(mode);
    if (permissionMode && isPermissionMode(permissionMode)) {
      return permissionMode;
    }
    return "default";
  });
  const [error, setError] = useState<string | null>(null);
  const [planApprovalActive, setPlanApprovalActive] = useState(false);
  const [prePlanMode, setPrePlanMode] = useState<PermissionMode>("default");
  // Recently invoked tool names, deduplicated and kept in call order. Passed to the
  // memory recall selector so it skips usage-guide memories for these tools, while
  // still surfacing pitfall and warning memories
  const recentToolsRef = useRef<string[]>([]);
  // Memory paths already injected this session; pre-filtered before recall to avoid
  // the same memory occupying a slot every turn
  const surfacedMemoriesRef = useRef<Set<string>>(new Set());
  const hasExitedPlanModeRef = useRef(false);
  const permModeRef = useRef(permMode);
  useEffect(() => {
    permModeRef.current = permMode;
  }, [permMode]);
  const [mcpInfo, setMcpInfo] = useState<{
    servers: string[];
    toolCount: number;
  } | null>(null);
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [footerRows, setFooterRows] = useState(2);
  // Bumped when workspace file facts change (file-write tool results, agent run
  // end); the @-mention completion cache in InputBox keys on it.
  const [fileFactsVersion, setFileFactsVersion] = useState(0);

  const workDir = process.cwd();
  const historyDir = `${workDir}/.yukino`;

  const clientRef = useRef<LLMClient | null>(null);
  // Resolved context window for the active provider: the configured
  // context_window value, or DEFAULT_CONTEXT_WINDOW when unset.
  const contextWindowRef = useRef(
    providers[0] ? getContextWindow(providers[0]) : DEFAULT_CONTEXT_WINDOW,
  );
  // Output ceiling for the active provider (PI's model.maxTokens equivalent).
  const maxOutputRef = useRef(
    providers[0] ? getMaxOutputTokens(providers[0]) : undefined,
  );
  const conversationRef = useRef(new ConversationManager());
  const sessionIdRef = useRef(sessionMod.newSessionId());
  const interactionStatsRef = useRef({
    agentActiveMs: 0,
    failedToolCalls: 0,
    startedAt: Date.now(),
    successfulToolCalls: 0,
    toolTimeMs: 0,
  });
  const activeToolIdsRef = useRef(new Set<string>());
  const activeToolBatchStartedAtRef = useRef<number | null>(null);
  const taskListRef = useRef(
    new TaskList(new TaskStore(workDir, sessionIdRef.current)),
  );
  const registryRef = useRef(
    (() => {
      const reg = createToolRegistry(workDir, taskListRef.current);

      const exitPlan = reg.getInstanceOf("ExitPlanMode", ExitPlanModeTool);
      if (exitPlan) {
        exitPlan.isPlanMode = () => permModeRef.current === "plan";
        exitPlan.planExists = () => {
          const p = getOrCreatePlanPath(workDir);
          return existsSync(p);
        };
      }
      return reg;
    })(),
  );
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
  const usageTrackerRef = useRef(new CommandUsageTracker(workDir));
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
  const memCursorRef = useRef(0);
  const memExtractingRef = useRef(false);
  const memExtractorRef = useRef<InstanceType<typeof MemoryExtractor> | null>(
    null,
  );
  const memManagerRef = useRef<InstanceType<typeof MemoryManager> | null>(null);
  const activeSkillsRef = useRef(new Map<string, string>());
  const toolFilterRef = useRef<((name: string) => boolean) | null>(null);
  const skillHostRef = useRef<SkillHost>({
    activateSkill: (name, body) => activeSkillsRef.current.set(name, body),
  });
  const teamManagerRef = useRef(new TeamManager(workDir));
  useEffect(() => {
    // Re-adopt any team left on disk (e.g. from a previous session) so live
    // external teammates' notifications are drained and the UI shows them.
    teamManagerRef.current.restoreFromDisk();
  }, []);
  const backgroundTaskManagerRef = useRef(new TaskManager());
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
  // Checker of the in-flight agent loop: a fresh checker is created per loop,
  // so mid-loop permission-mode changes (Shift+Tab) must be applied to this
  // live instance to take effect before the loop ends.
  const checkerRef = useRef<PermissionChecker | null>(null);
  const permissionResolveRef = useRef<
    ((v: "allow" | "deny" | "allowAlways") => void) | null
  >(null);
  const [rewindDialogActive, setRewindDialogActive] = useState(false);
  const [rewindSnapshots, setRewindSnapshots] = useState<Snapshot[]>([]);
  // Steering messages queued into the in-flight agent, mirrored for display.
  // Entries are removed when the agent reports them delivered.
  const [steeringPending, setSteeringPending] = useState<string[]>([]);
  // Steering texts already written to prompt history at steer time. Consumed
  // when the text enters the conversation (delivered in-run or re-fed as a
  // follow-up), so the follow-up path records each user prompt exactly once.
  const steeringHistoryRecordedRef = useRef<string[]>([]);
  const [resumeSessions, setResumeSessions] = useState<
    sessionMod.SessionInfo[]
  >([]);
  const [resumeDialogActive, setResumeDialogActive] = useState(false);
  const initialResumeHandledRef = useRef(false);
  const [permissionRequest, setPermissionRequest] = useState<{
    toolName: string;
    argsSummary: string;
    reason: string;
  } | null>(null);
  const [askRequest, setAskRequest] = useState<Question[] | null>(null);
  const askResolveRef = useRef<((a: Record<string, string>) => void) | null>(
    null,
  );
  const teammateStates = useTeammateStates(teamManagerRef.current);
  const [teamsDialogOpen, setTeamsDialogOpen] = useState(false);
  const [subagents, setSubagents] = useState<SubagentProgress[]>([]);
  const [backgroundTasks, setBackgroundTasks] = useState<AgentTask[]>([]);
  const subagentIdRef = useRef(0);
  // Terminal card decoration (status + progress line) for Agent calls, keyed by
  // tool call id. Consulted when the tool result is committed to transcript
  // history so an interrupted run shows red "stopped" instead of a green
  // success card whose only hint is an "[Interrupted]" tail. Background calls
  // resolve before their subagent finalizes, so they commit undecorated.
  const subagentCardsRef = useRef(new Map<string, AgentCardDecoration>());
  const { insertInputTextRef, clearInputRef } = useIdeInput(workDir);

  useEffect(
    () => backgroundTaskManagerRef.current.subscribe(setBackgroundTasks),
    [],
  );

  // Interrupt scope: a single Ctrl+C / Esc routes to interruptForeground,
  // which only stops foreground execution — the in-flight agent loop (its
  // signal is shared by synchronous tool calls and run_in_background=false
  // subagents), a forked slash skill, /compact, or a code review. Background
  // tasks, background subagents and teammates own separate abort controllers and keep running;
  // only the TUI-exit path (double Ctrl+C, /quit) tears them down through
  // interruptAll().
  const { interruptForeground, interruptAll } = useMemo(
    () =>
      createInterruptHandlers({
        abortControllerRef,
        permissionResolveRef,
        setPermissionRequest,
        askResolveRef,
        setAskRequest,
        backgroundTasks: backgroundTaskManagerRef.current,
        teams: teamManagerRef.current,
      }),
    [],
  );

  const requestExit = useCallback(() => {
    void (async () => {
      interruptAll();
      // Join the fire-and-forget stopAlls and disconnect MCP before the app
      // unmounts (parity with print-mode/ACP): on Windows the shell kills go
      // through async taskkill, and stdio MCP children need an explicit close.
      try {
        await Promise.all([
          backgroundTaskManagerRef.current.stopAll(),
          teamManagerRef.current.stopAll(),
        ]);
      } catch {
        // best-effort — exit regardless
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
      onExitSummary?.({
        ...interactionStatsRef.current,
        ...output.usageTotalsRef.current,
        sessionId: sessionIdRef.current,
        toolTimeMs: interactionStatsRef.current.toolTimeMs + activeToolTime,
      });
      exit();
    })();
  }, [exit, interruptAll, onExitSummary]);

  // Foreground-only work gate for Ctrl+C/Esc: while only background work is
  // running, a press must fall through to the press-twice-to-exit flow
  // instead of interrupting anything.
  const foregroundBusy = isForegroundBusy(isStreaming, isCompacting, subagents);
  const { termWidth, toolsExpanded, ctrlCHint } = useTerminalControls({
    isStreaming,
    hasRunningWork: foregroundBusy,
    clearInputRef,
    onInterrupt: interruptForeground,
    onExit: requestExit,
    teamsDialogOpen,
    onToggleTeams: () => {
      setTeamsDialogOpen((open) => !open);
    },
    onBackgroundShells: () => {
      // Gate the keypress: keep Ctrl+B inert when nothing is backgroundable,
      // and yield the key to the provider-login form while it is open (that
      // form binds Ctrl+B to cursor-back — ink dispatches to every mounted
      // useInput handler, so an ungated handler would double-fire).
      if (loginActive || !hasAnyForegroundTasks(registryRef.current)) {
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
        : isStreaming
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
          );
          mcpModeDecidedRef.current = true;
        }
      }

      syncMcpInstructions(mgr);
    },
    [syncMcpInstructions],
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
  // project .mcp.json), keeps unchanged connections, disconnects removed ones,
  // and connects new or reconfigured servers.
  const reloadMcpServers = useCallback(
    () =>
      runMcpOperation(async () => {
        let servers: MCPServerConfig[];
        try {
          servers = withProjectMcpServers(loadConfig(), workDir).mcp_servers;
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
            await previous.reconcile([]);
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
        const result = await mgr.reconcile(servers);
        // Unchanged wrappers keep both their schemas and live clients. Removed and
        // reconfigured servers must lose their old wrappers before new schemas are
        // registered below. A restarted server also gets a fresh connection, so the
        // instructions announced for the old one are stale — forget them and let
        // applyMcpResult announce the new ones.
        for (const name of result.restarted) {
          announcedMcpServersRef.current.delete(name);
        }
        removeMcpTools(
          registryRef.current,
          new Set([...result.removed, ...result.restarted]),
        );
        applyMcpResult(mgr, selectedProviderRef.current, result);
        setMessages((prev) => [
          ...prev,
          {
            role: "system",
            content:
              `MCP reloaded: ${String(mgr.connectedServers().length)} server(s) connected, ` +
              `${String(countMcpTools(registryRef.current))} tool(s) ` +
              `(${String(result.added.length)} added, ${String(result.removed.length)} removed, ` +
              `${String(result.restarted.length)} restarted, ${String(result.unchanged.length)} unchanged)`,
          },
        ]);
      }),
    [workDir, applyMcpResult, runMcpOperation, syncMcpInstructions],
  );

  const initClient = useCallback(
    async (provider: ProviderConfig) => {
      try {
        const hookErr = validateHooks(hooks);
        if (hookErr) {
          throw hookErr;
        }

        const env = detectEnvironment(workDir);
        env.model = provider.model;
        const systemPrompt = buildSystemPrompt(env);
        const client = await createClient(provider, systemPrompt);
        clientRef.current = client;

        contextWindowRef.current = getContextWindow(provider);
        maxOutputRef.current = getMaxOutputTokens(provider);

        fileHistoryRef.current = new FileHistory(workDir, sessionIdRef.current);

        const instructions = loadInstructions(workDir);
        // enable_memory: false disables the whole auto-memory pipeline; no
        // manager is created so nothing scans, rebuilds MEMORY.md, or injects
        // reminders.
        const memMgr = memoryEnabled ? new MemoryManager(workDir) : null;
        memManagerRef.current = memMgr;
        const memReminder = memMgr?.buildSystemReminder() ?? "";
        conversationRef.current.injectLongTermMemory(instructions, memReminder);

        setPromptHistory(historyMod.load(historyDir));

        hookEngineRef.current = new HookEngine(hooks);

        const catalog = new SkillCatalog();
        catalog.load(workDir);
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
          new InstallSkillTool(workDir, catalog, () => {
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

        // Register AskUserQuestion, delegating the prompt to the UI dialog.
        registryRef.current.register(
          new AskUserQuestionTool(
            (questions) =>
              new Promise<Record<string, string>>((resolve) => {
                askResolveRef.current = resolve;
                setAskRequest(questions);
              }),
          ),
        );

        // Register team coordination tools. Teammates run as background
        // general-purpose subagents whose results return via the team channel.
        // backgroundTasks:false — a teammate loop is one spawnSubagent run per
        // task turn, so a per-run manager's turn-end stopAll() would kill
        // anything the teammate backgrounded; teammates stay purely foreground.
        const teamRunAgent: RunAgent = (task, onEvent, abortSignal) =>
          spawnSubagent(
            BUILTIN_AGENTS[0],
            task,
            clientRef.current ?? client,
            registryRef.current,
            selectedProviderRef.current,
            workDir,
            undefined,
            onEvent,
            undefined,
            undefined,
            { abortSignal, backgroundTasks: false },
          );
        // RunAgent factory for teammates: runs the teammate agent main loop
        // against the teammate-scoped registry (shared task-board tools are
        // already injected by AgentTool before this factory is called).
        const teamRunAgentFactory =
          (
            registry: ToolRegistry,
            teamChecker?: PermissionChecker,
            memberWorkDir = workDir,
          ): RunAgent =>
          (task, onEvent, abortSignal) =>
            spawnSubagent(
              BUILTIN_AGENTS[0],
              task,
              clientRef.current ?? client,
              registry,
              selectedProviderRef.current,
              memberWorkDir,
              undefined,
              onEvent,
              undefined,
              teamChecker,
              { abortSignal, backgroundTasks: false },
            );
        registryRef.current.register(
          new TeamCreateTool(teamManagerRef.current),
        );
        // No provider index is passed: external teammates resolve
        // `default_provider` from the config, which rememberProvider keeps in
        // sync with the active selection.
        registryRef.current.register(
          new SpawnTeammateTool(teamManagerRef.current, teamRunAgent),
        );
        registryRef.current.register(
          new SendMessageTool(teamManagerRef.current),
        );
        registryRef.current.register(new ListTeamsTool(teamManagerRef.current));
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

        // Load user-defined slash commands from .yukino/commands/*.md
        // (user home, then project — project wins on a name collision).
        for (const cmd of loadUserCommands(workDir)) {
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

        // Track a subagent run for the UI. Maintains the live progress card
        // (SubagentProgress) and records the terminal decoration (status +
        // progress line) consumed when the Agent call is committed to the
        // transcript, so an interrupted run renders as red "stopped" instead
        // of a green success card. Shared by the definition spawn path and
        // the fork path.
        const trackSubagent = async (
          tracking: {
            toolCallId: string;
            role: string;
            taskId?: string;
            abortSignal?: AbortSignal;
          },
          run: (onEvent: AgentEventSink) => Promise<string>,
        ): Promise<string> => {
          const { toolCallId, role, taskId, abortSignal } = tracking;
          const runningTools = new Map<string, string>();
          let turns = 0;
          // Last started tool name — kept after the tool finishes so the card's
          // progress line shows it until the next tool call replaces it.
          let lastTool: string | undefined;
          const syncRunningTools = () => {
            const tools = [...runningTools].map(([toolId, toolName]) => ({
              toolId,
              toolName,
            }));
            setSubagents((prev) =>
              prev.map((subagent) =>
                subagent.toolCallId === toolCallId
                  ? { ...subagent, activeTools: tools, lastTool }
                  : subagent,
              ),
            );
          };
          setSubagents((prev) => [
            ...prev.filter((subagent) => subagent.toolCallId !== toolCallId),
            {
              toolCallId,
              ...(taskId ? { taskId } : {}),
              role,
              turnCount: 0,
              activeTools: [],
              status: "running",
            },
          ]);
          const finalize = (
            status: SubagentProgress["status"],
            output: string,
          ) => {
            subagentCardsRef.current.set(toolCallId, {
              status,
              progress: `${role} subagent | ${String(turns)} turns`,
            });
            setSubagents((prev) =>
              prev.map((subagent) =>
                subagent.toolCallId === toolCallId
                  ? {
                      ...subagent,
                      activeTools: [],
                      lastTool: undefined,
                      status,
                      output,
                    }
                  : subagent,
              ),
            );
          };
          const onEvent: AgentEventSink = (event) => {
            switch (event.type) {
              case "tool_use":
                lastTool = event.toolName;
                runningTools.set(event.toolId, event.toolName);
                syncRunningTools();
                break;
              case "tool_result":
                runningTools.delete(event.toolId);
                syncRunningTools();
                break;
              case "turn_complete":
                runningTools.clear();
                turns += 1;
                setSubagents((prev) =>
                  prev.map((subagent) =>
                    subagent.toolCallId === toolCallId
                      ? {
                          ...subagent,
                          turnCount: subagent.turnCount + 1,
                          activeTools: [],
                        }
                      : subagent,
                  ),
                );
                break;
              case "usage":
                break;
            }
          };
          try {
            const result = await run(onEvent);
            // An abort that lands while the subagent is finishing still means
            // the user stopped it — render "stopped", never "completed".
            finalize(abortSignal?.aborted ? "stopped" : "completed", result);
            return result;
          } catch (error) {
            finalize(
              abortSignal?.aborted ? "stopped" : "failed",
              `Agent error: ${asErrorString(error)}`,
            );
            throw error;
          }
        };

        const agentTool = new AgentTool(
          workDir,
          registryRef.current,
          (
            def,
            prompt,
            background,
            modelOverride?,
            workDirOverride?,
            context?,
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
                  workDirOverride ?? workDir,
                  undefined,
                  onEvent,
                  modelOverride,
                  workDirOverride
                    ? context?.permissionChecker?.forWorkDir(workDirOverride)
                    : context?.permissionChecker,
                  {
                    abortSignal: context?.abortSignal,
                    background,
                    onPermissionRequest: context?.onPermissionRequest,
                    permissionMode: context?.permissionChecker?.mode,
                  },
                ),
            );
          },
          conversationRef.current,
          (prompt, conversation, registry, modelOverride, context) => {
            const toolCallId =
              context?.toolCallId ??
              `subagent-${String(++subagentIdRef.current)}`;
            return trackSubagent(
              {
                toolCallId,
                role: BUILTIN_AGENTS[0].name,
                taskId: context?.backgroundTaskId,
                abortSignal: context?.abortSignal,
              },
              (onEvent) =>
                spawnSubagent(
                  BUILTIN_AGENTS[0],
                  prompt,
                  clientRef.current ?? client,
                  registry,
                  selectedProviderRef.current,
                  context?.workDir ?? workDir,
                  undefined,
                  onEvent,
                  modelOverride,
                  context?.permissionChecker,
                  {
                    conversation,
                    abortSignal: context?.abortSignal,
                    onPermissionRequest: context?.onPermissionRequest,
                  },
                ),
            );
          },
          backgroundTaskManagerRef.current,
        );
        agentTool.forkDisabled = forkDisabled ?? false;
        // Wire the team manager into AgentTool to enable the team_name teammate path (teammates receive shared task-board tools)
        // The provider index is left unset so external teammates follow the
        // persisted `default_provider`, i.e. the active selection.
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
      workDir,
      mcpServers,
      connectMcpServers,
      memoryEnabled,
      hooks,
      forkDisabled,
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
        const environment = detectEnvironment(workDir);
        environment.model = provider.model;
        const client = await createClient(
          provider,
          buildSystemPrompt(environment),
        );
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
      const environment = detectEnvironment(workDir);
      environment.model = updated.model;
      const client = await createClient(
        updated,
        buildSystemPrompt(environment),
      );
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
      );
      // Capability metadata follows the model; drop derived state.
      memExtractorRef.current = null;
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

  const handleSlashCommand = async (text: string): Promise<boolean> => {
    let parsed = parseCommand(text);
    if (!parsed) {
      return false;
    }

    // /mcp — show MCP server status, first retrying any server still not
    // connected; /mcp reload re-reads the config from disk and reconciles it.
    if (parsed.name === "mcp") {
      usageTrackerRef.current.record("mcp");
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

    // `/skill <name> [args]` shorthand: rewrite to `/<name> [args]` so it
    // goes through the normal command registry path (skills are wired there).
    // Exception: `/skill reload` routes to the /skills handler instead.
    if (parsed.name === "skill" && parsed.args.trim()) {
      const parts = parsed.args.trim().split(/\s+/);
      if (parts[0] === "reload") {
        parsed = { name: "skills", args: "reload" };
      } else {
        parsed = { name: parts[0], args: parts.slice(1).join(" ") };
      }
    }

    const cmd = cmdRegistryRef.current.find(parsed.name);
    if (cmd) {
      usageTrackerRef.current.record(cmd.name);
    }
    if (!cmd) {
      setMessages((prev) => [
        ...prev,
        { role: "system", content: `Unknown command: /${parsed.name}` },
      ]);
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
        `Directory: ${workDir}`,
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
      const mgr = new MemoryManager(workDir);
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
      const action = cmd.handler({ workDir, args: parsed.args });
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
          await Promise.all([
            backgroundTaskManagerRef.current.stopAll(),
            teamManagerRef.current.stopAll(),
          ]);
          backgroundTaskManagerRef.current.clear();
          setSubagents([]);
          subagentCardsRef.current.clear();
          // Clear messages and start a fresh conversation. Reset in place —
          // AgentTool captures the manager for its fork path, so swapping the
          // instance would leave it pointing at the discarded history.
          setMessages([]);
          conversationRef.current.reset();
          announcedSkillsRef.current.clear();
          conversationRef.current.injectLongTermMemory(
            loadInstructions(workDir),
            memManagerRef.current?.buildSystemReminder() ?? "",
          );
          // The fresh history holds no MCP announcement any more, so this re-sends
          // the instructions of every connected server.
          if (mcpManagerRef.current) {
            syncMcpInstructions(mcpManagerRef.current);
          }
          // Reset the session ID and the stores derived from it
          sessionIdRef.current = sessionMod.newSessionId();
          interactionStatsRef.current = {
            agentActiveMs: 0,
            failedToolCalls: 0,
            startedAt: Date.now(),
            successfulToolCalls: 0,
            toolTimeMs: 0,
          };
          activeToolIdsRef.current.clear();
          activeToolBatchStartedAtRef.current = null;
          taskListRef.current.useStore(
            new TaskStore(workDir, sessionIdRef.current),
          );
          fileHistoryRef.current = new FileHistory(
            workDir,
            sessionIdRef.current,
          );
          output.resetUsage();
          // Reset memory extraction, recall and compact-recovery state
          memCursorRef.current = 0;
          memExtractingRef.current = false;
          recentToolsRef.current = [];
          surfacedMemoriesRef.current.clear();
          recoveryStateRef.current = new RecoveryState();
          // Clear both the visible screen and terminal scrollback. Changing the
          // session ID remounts the static brand block on the next render.
          process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
          break;
        }
        case "quit":
          requestExit();
          break;
        case "plan": {
          setPrePlanMode(permMode);
          permModeRef.current = "plan";
          setPermMode("plan");
          const planPath = getOrCreatePlanPath(workDir);
          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              content:
                `Entered plan mode (read-only). Plan file: ${planPath}\n` +
                "Investigate and design your approach. The agent will call ExitPlanMode when the plan is ready.",
            },
          ]);
          // Re-entry after a previous plan-mode exit: if the plan file still
          // exists, rebuild the re-entry reminder
          if (hasExitedPlanModeRef.current && planExists(workDir)) {
            const reentryMsg = buildPlanModeReentryReminder(planPath, true);
            if (reentryMsg) {
              conversationRef.current.addSystemReminder(reentryMsg);
              setMessages((prev) => [
                ...prev,
                { role: "system", content: reentryMsg },
              ]);
            }
            hasExitedPlanModeRef.current = false;
          }
          if (parsed.args) {
            await runUserTurn(parsed.args, "plan");
          }
          break;
        }
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
              sessionMod.getSessionFilePath(workDir, sessionIdRef.current),
              controller.signal,
              parsed.args,
            )
              .then((result) => {
                // Persist the boundary so the compacted state survives /resume.
                if (result.boundary) {
                  sessionMod.saveCompactBoundary(
                    workDir,
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
        case "code-review":
          setCodeReviewActive(true);
          break;
        case "code-review-usage":
          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              content: "Usage: /code-review",
            },
          ]);
          break;
        case "resume": {
          const arg = parsed.args.trim();
          if (!arg) {
            const sessions = sessionMod
              .listSessions(workDir)
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

          const saved = sessionMod.loadSession(workDir, arg);
          if (saved.length === 0) {
            const sessions = sessionMod
              .listSessions(workDir)
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
          const conv = conversationRef.current;
          conv.reset();
          conv.injectLongTermMemory(
            loadInstructions(workDir),
            memoryEnabled
              ? new MemoryManager(workDir).buildSystemReminder()
              : "",
          );
          const restored = sessionMod.rebuildFromSession(saved);
          conv.appendMessages(
            restored.map((message) => ({
              ...message,
              toolUses: message.toolUses?.map((tool) => ({
                ...tool,
                arguments: tool.arguments ?? {},
              })),
            })),
          );
          announcedSkillsRef.current.clear();
          sessionIdRef.current = arg;
          // Mark the session active: expiry sweeping is mtime-based, and a
          // resumed-but-not-yet-written session still carries its old stamp.
          sessionMod.touchSession(workDir, arg);
          setResumeDialogActive(false);
          setResumeSessions([]);
          recentToolsRef.current = [];
          surfacedMemoriesRef.current.clear();
          recoveryStateRef.current = new RecoveryState();
          taskListRef.current.useStore(new TaskStore(workDir, arg));
          // Re-key file history to the resumed session. Snapshots persist per
          // session and are reloaded on construction; /rewind after a resume
          // truncates the session log at the snapshot's recorded line count and
          // rebuilds the conversation from it, so stale in-memory message
          // indexes from the previous process are never trusted.
          fileHistoryRef.current = new FileHistory(workDir, arg);
          const resumedMessages = transcriptFromRestored(restored);
          resumedMessages.push({
            role: "system",
            content: `⟲ Resumed session ${arg} (${String(restored.length)} messages).`,
          });
          setMessages(resumedMessages);
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
              cwd: workDir,
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
        workDir,
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
      setMessages((prev) => [...prev, { role: "system", content: output }]);
      return true;
    }

    if (cmd.type === "prompt") {
      // File-based custom command or inline skill: render the body and run it as a user turn.
      const promptText = cmd.handler({ workDir, args: parsed.args });
      if (clientRef.current && promptText.trim()) {
        setMessages((prev) => [...prev, { role: "user", content: promptText }]);
        conversationRef.current.addUserMessage(promptText);
        sessionMod.saveMessage(workDir, sessionIdRef.current, {
          role: "user",
          content: promptText,
          timestamp: Math.floor(Date.now() / 1000),
        });
        setIsStreaming(true);
        setSubagents([]);
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
            workDir,
            undefined,
            undefined,
            undefined,
            undefined,
            { abortSignal: signal ?? controller.signal },
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

  const runAgentLoop = async (modeOverride?: PermissionMode) => {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const onAgentEvent = output.createEventHandler((toolId) =>
      subagentCardsRef.current.get(toolId),
    );

    // modeOverride avoids a stale-closure read of permMode right after a
    // setPermMode call (e.g. `/plan <args>` entering plan mode in the same tick).
    const checker = new PermissionChecker(workDir, modeOverride ?? permMode);
    checkerRef.current = checker;

    const bashTool = registryRef.current.getInstanceOf("Bash", BashTool);
    let sandboxReady = false;
    if (bashTool && sandboxEnabledRef.current) {
      const sandbox = await getSandbox();
      sandboxReady = (await sandbox?.available()) ?? false;
      bashTool.sandbox = sandbox;
      bashTool.sandboxRequired = true;
      bashTool.sandboxConfig = {
        // tmpdir is required: mktemp, compilers, git, and python tempfile all
        // default to it. seatbelt.ts canonicalizes symlinked spellings
        // ("/tmp" -> "/private/tmp", "/var/..." -> "/private/var/...").
        allowWrite: [workDir, "/tmp", tmpdir()],
        denyWrite: [],
        networkEnabled: sandboxNetworkEnabled,
      };
    } else if (bashTool) {
      bashTool.sandbox = null;
      bashTool.sandboxRequired = false;
    }

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
      workDir,
      sessionId: sessionIdRef.current,
      hookEngine: hookEngineRef.current ?? undefined,
      fileHistory: fileHistoryRef.current ?? undefined,
      fileStateCache: fileStateCacheRef.current,
      abortSignal: controller.signal,
      contextWindow: contextWindowRef.current,
      maxOutput: maxOutputRef.current,
      recoveryState: recoveryStateRef.current,
      activeSkills: activeSkillsRef.current,
      // The first system-reminder carries the full skill list; later turns
      // only append the delta
      instructions: loadInstructions(workDir),
      memoryContent: memManagerRef.current?.buildSystemReminder() ?? "",
      skillSection: skillCatalogRef.current
        ? buildSkillSection(skillCatalogRef.current, workDir)
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
        if (!client || !memoryEnabled || memExtractingRef.current) {
          return;
        }
        if (conv.len() - memCursorRef.current < 2) {
          return;
        }
        memExtractingRef.current = true;
        const cursor = conv.len();
        const summary = conv
          .getMessages()
          .slice(-40)
          .map((m) => `[${m.role}]: ${contentToText(m.content)}`)
          .filter((s) => s.length > 12)
          .join("\n");
        // Lazy-init the Memory Extractor (one per logged-in client, reused
        // across turns and sessions; discarded on re-login)
        memExtractorRef.current ??= new MemoryExtractor(client, workDir);
        memExtractorRef.current
          .extract(summary)
          .then((saved) => {
            memCursorRef.current = cursor;
            if (saved.length > 0) {
              setMessages((prev) => [
                ...prev,
                {
                  role: "system",
                  content: `Memory saved: ${saved.join(", ")}`,
                },
              ]);
            }
          })
          .catch((err: unknown) => {
            log.error({ err }, "memory extractor failed");
          })
          .finally(() => {
            memExtractingRef.current = false;
          });
      },
      onPermissionRequest: async (toolName, args, decision) => {
        return new Promise<"allow" | "deny" | "allowAlways">((resolve) => {
          permissionResolveRef.current = resolve;
          setPermissionRequest({
            toolName,
            argsSummary: formatToolArgs(args),
            reason: decision.reason,
          });
        });
      },
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
            if (event.toolName === "ExitPlanMode" && !event.isError) {
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
            // Remove exactly one occurrence: the same text may be queued twice.
            setSteeringPending((prev) => {
              const idx = prev.indexOf(event.text);
              return idx === -1 ? prev : prev.filter((_, i) => i !== idx);
            });
            const recorded = steeringHistoryRecordedRef.current;
            const recordedIdx = recorded.indexOf(event.text);
            if (recordedIdx !== -1) {
              recorded.splice(recordedIdx, 1);
            }
            setMessages((prev) => [
              ...prev,
              { role: "user", content: event.text },
            ]);
            break;
          }
          case "compact": {
            if (event.boundary) {
              sessionMod.saveCompactBoundary(
                workDir,
                sessionIdRef.current,
                event.boundary,
              );
            }
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
      // Steering queued too late for in-run delivery becomes follow-up turns —
      // unless the user interrupted the run: "stop" means the queued messages
      // must not fire immediately (parity with the remote server's cancel
      // guard). They are removed from the pending list instead.
      const leftover = agent.drainSteering();
      if (leftover.length > 0) {
        // Remove one pending entry per leftover item, not every text match.
        setSteeringPending((prev) => {
          const next = [...prev];
          for (const text of leftover) {
            const idx = next.indexOf(text);
            if (idx !== -1) {
              next.splice(idx, 1);
            }
          }
          return next;
        });
        if (controller.signal.aborted) {
          const recorded = steeringHistoryRecordedRef.current;
          for (const text of leftover) {
            const idx = recorded.indexOf(text);
            if (idx !== -1) {
              recorded.splice(idx, 1);
            }
          }
        } else {
          for (const text of leftover) {
            followUps.enqueue(text);
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
    setSubagents([]);
    output.prepareTurn();
    setError(null);

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
    }
  };

  const runUserTurn = async (text: string, modeOverride?: PermissionMode) => {
    await runAgentTurn(async () => {
      setMessages((prev) => [...prev, { role: "user", content: text }]);
      const expanded = await expandAtRefsWithImages(text, workDir);
      conversationRef.current.addUserMessage(expanded);
      sessionMod.saveMessage(workDir, sessionIdRef.current, {
        role: "user",
        content:
          typeof expanded === "string"
            ? text
            : [
                { type: "text", text },
                ...expanded.filter((block) => block.type === "image"),
              ],
        timestamp: Math.floor(Date.now() / 1000),
      });
    }, modeOverride);
  };

  const runNotificationTurn = async (): Promise<void> => {
    await runAgentTurn();
  };

  const handlePlanApproval = useCallback(
    (choice: PlanChoice, feedback?: string) => {
      setPlanApprovalActive(false);
      const planPath = getOrCreatePlanPath(workDir);
      let planContent = "";
      try {
        if (existsSync(planPath)) {
          planContent = readFileSync(planPath, "utf-8");
        }
      } catch {
        /** noop */
      }

      if (choice === "yolo") {
        hasExitedPlanModeRef.current = true;
        setPermMode("bypassPermissions");

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
        // Exit plan mode and restore the pre-plan permission mode
        hasExitedPlanModeRef.current = true;
        setPermMode(prePlanMode);
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
    [workDir, prePlanMode],
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
      workDir,
      sessionIdRef.current,
    );
    if (snap.sessionLineCount !== undefined && existsSync(sessionFilePath)) {
      sessionMod.truncateSessionLines(sessionFilePath, snap.sessionLineCount);
      const rebuilt = sessionMod.rebuildFromSession(
        sessionMod.loadSession(workDir, sessionIdRef.current),
      );
      conversationRef.current.reset();
      conversationRef.current.appendMessages(rebuilt);
      return transcriptFromRestored(rebuilt);
    }
    conversationRef.current.truncateTo(snap.messageIndex);
    return transcriptFromRestored(
      conversationRef.current.getMessages().filter((m) => m.role !== "system"),
    );
  };

  const handleRewindAction = useCallback(
    (action: RewindAction) => {
      setRewindDialogActive(false);
      const fh = fileHistoryRef.current;
      if (!fh) {
        return;
      }

      switch (action.type) {
        case "code_and_conversation": {
          const changed = fh.rewind(action.snapshotIndex);
          const snap = rewindSnapshots[action.snapshotIndex];
          const transcript = rewindConversation(snap);
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
          break;
        }
        case "conversation_only": {
          const snap = rewindSnapshots[action.snapshotIndex];
          const transcript = rewindConversation(snap);
          setMessages([
            ...transcript,
            {
              role: "system",
              content: `⟲ Rewound conversation. Files unchanged.`,
            },
          ]);
          break;
        }
        case "code_only": {
          const changed = fh.rewind(action.snapshotIndex);
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
        case "cancel":
          break;
      }
    },
    [rewindSnapshots],
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

  const processSubmission = async (text: string) => {
    refreshSkillsIfNeeded();
    // Steering leftovers were recorded when they were steered; consume the
    // marker instead of appending again so each user prompt lands once.
    const recorded = steeringHistoryRecordedRef.current;
    const recordedIdx = recorded.indexOf(text);
    if (recordedIdx !== -1) {
      recorded.splice(recordedIdx, 1);
    } else {
      setPromptHistory(historyMod.append(historyDir, text));
    }
    if (text.startsWith("/") && (await handleSlashCommand(text))) {
      return;
    }
    await runUserTurn(text);
  };

  const turnBlocked =
    appState !== "chat" ||
    !clientRef.current ||
    isStreaming ||
    isCompacting ||
    providerSwitching ||
    loginActive ||
    codeReviewActive ||
    providerDialogActive ||
    modelDialogActive ||
    thinkingDialogActive ||
    planApprovalActive ||
    rewindDialogActive ||
    resumeDialogActive ||
    permissionRequest !== null ||
    askRequest !== null ||
    teamsDialogOpen;
  const followUps = useFollowUpQueue({
    blocked: turnBlocked,
    send: processSubmission,
    onError: (error) => {
      setError(asErrorString(error));
    },
  });
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
    if (isStreaming && !trimmed.startsWith("/") && agentRef.current) {
      agentRef.current.steer(trimmed);
      setSteeringPending((prev) => [...prev, trimmed]);
      setPromptHistory(historyMod.append(historyDir, trimmed));
      steeringHistoryRecordedRef.current.push(trimmed);
      return;
    }
    followUps.enqueue(text);
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
    if (steered !== undefined && agentRef.current?.removeSteering(steered)) {
      setSteeringPending((prev) => prev.slice(0, -1));
      return steered;
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

  const handleCodeReview = (reviewOptions: CodeReviewFormOptions): void => {
    if (!clientRef.current) {
      setMessages((prev) => [
        ...prev,
        { role: "system", content: "Client not ready." },
      ]);
      return;
    }

    setCodeReviewActive(false);
    const controller = new AbortController();
    const onReviewEvent = output.createEventHandler();
    abortControllerRef.current = controller;
    output.prepareTurn();
    setIsStreaming(true);

    void runCodeReview(
      {
        workDir,
        ...reviewOptions,
        abortSignal: controller.signal,
        onToolEvent: onReviewEvent,
      },
      { provider: selectedProviderRef.current },
    )
      .then((result) => {
        const report = formatReviewReport(result);
        onReviewEvent({ type: "stream_text", text: report });
        onReviewEvent({ type: "turn_complete" });
        if (result.comments.length > 0) {
          conversationRef.current.addSystemReminder(
            `<code_review_findings>\n${report}\n</code_review_findings>`,
          );
        }
      })
      .catch((err: unknown) => {
        onReviewEvent({ type: "turn_complete" });
        setMessages((prev) => [
          ...prev,
          {
            role: "system",
            content: `Review failed: ${asErrorString(err)}`,
          },
        ]);
      })
      .finally(() => {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        setIsStreaming(false);
      });
  };

  const handleLogin = async (input: ProviderConfig): Promise<void> => {
    const environment = detectEnvironment(workDir);
    environment.model = input.model;
    // Construct before saving so invalid client configuration leaves the form editable.
    const client = await createClient(input, buildSystemPrompt(environment));
    const saved = saveProvider(input, providers);
    setProviders(saved.providers);
    setError("");
    if (clientRef.current) {
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
      );
      memExtractorRef.current = null;
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
    <Box flexDirection="column" width="100%">
      <Box flexDirection="column" paddingTop={0} flexGrow={1}>
        <Transcript
          messages={messages}
          sessionId={sessionIdRef.current}
          termWidth={termWidth}
          expanded={toolsExpanded}
          model={selectedProvider.model || selectedProvider.name}
          workDir={workDir}
          provider={selectedProvider.name}
        />

        <ChatView
          messages={[]}
          streamingText={isStreaming ? streamingText : undefined}
          thinkingText={isStreaming ? streamingThinking : undefined}
          expanded={toolsExpanded}
        />

        <AgentActivity
          tools={activeTools}
          persistentAgentTools={persistentAgentTools}
          subagents={subagents}
          backgroundTasks={backgroundTasks}
          teammates={teammateStates}
          isAsking={askRequest !== null}
          expanded={toolsExpanded}
        />

        {error && (
          <Box marginTop={1} paddingLeft={1}>
            <Text color={THEME.error}>Error: {error}</Text>
          </Box>
        )}

        <PendingQueue messages={pendingMessages} steering={steeringPending} />
        <Text> </Text>
      </Box>

      {ctrlCHint && (
        <Box paddingLeft={1}>
          <Text color={THEME.dim}>Press Ctrl+C again to exit.</Text>
        </Box>
      )}
      <TeamStatus
        count={
          teammateStates.filter(
            (t) => t.status === "running" || t.status === "idle",
          ).length
        }
      />
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
        codeReview={
          codeReviewActive
            ? {
                onSubmit: handleCodeReview,
                onCancel: () => {
                  setCodeReviewActive(false);
                },
              }
            : undefined
        }
        provider={
          providerDialogActive
            ? {
                providers,
                currentProviderIndex: providerIndexOf(selectedProvider),
                reservedRows: footerRows,
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
                reservedRows: footerRows,
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
                currentSessionId: sessionIdRef.current,
                reservedRows: footerRows,
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
                },
              }
            : undefined
        }
        askUser={
          askRequest
            ? {
                questions: askRequest,
                onComplete: (answers) => {
                  askResolveRef.current?.(answers);
                  askResolveRef.current = null;
                  setAskRequest(null);
                },
              }
            : undefined
        }
        teams={
          teamsDialogOpen
            ? {
                teammates: teammateStates,
                onClose: () => {
                  setTeamsDialogOpen(false);
                },
                onKill: (name, teamName) => {
                  const team = teamManagerRef.current.get(teamName);
                  if (team) {
                    void team.stopMember(name);
                  }
                },
                onShutdown: (name, teamName) => {
                  const team = teamManagerRef.current.get(teamName);
                  if (team) {
                    void team.sendMessage(
                      LEADER_NAME,
                      name,
                      `${SHUTDOWN_PREFIX} Please finish and exit`,
                    );
                  }
                },
              }
            : undefined
        }
        composer={{
          onSubmit: (text) => {
            handleSubmit(text);
          },
          disabled: providerSwitching,
          history: promptHistory,
          commands: cmdRegistryRef.current.listCommands(),
          thinkingLevels: availableThinkingLevels,
          onRecallQueuedMessage: recallQueuedMessage,
          usageTracker: usageTrackerRef.current,
          inputState: error
            ? "error"
            : isStreaming || isCompacting || providerSwitching
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
                : isStreaming
                  ? (output.retryStatus ?? "Working")
                  : undefined,
          permMode,
          onModeChange: (mode) => {
            setPermMode(mode);
            if (checkerRef.current) {
              checkerRef.current.mode = mode;
            }
          },
          workDir,
          sessionId: sessionIdRef.current,
          fileFactsVersion,
          insertTextRef: insertInputTextRef,
          clearRef: clearInputRef,
          onEscape: () => {
            if (foregroundBusy) {
              interruptForeground();
            }
          },
        }}
      />
      <Footer
        onHeightChange={setFooterRows}
        contextTokens={currentContextTokens(conversationRef.current)}
        contextWindow={contextWindowRef.current}
        inputTokens={inputTokens}
        model={selectedProvider.model}
        thinkingLevel={thinkingLevel}
        outputTokens={outputTokens}
        permissionMode={permMode}
        provider={selectedProvider.name}
        sessionId={sessionIdRef.current}
        workDir={workDir}
      />
    </Box>
  );
}
