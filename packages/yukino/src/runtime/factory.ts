import { randomUUID } from "node:crypto";

import { configureBashSandbox } from "@/bootstrap/sandbox.js";
import {
  createToolRegistry,
  wireSkillsToRegistry,
} from "@/bootstrap/tool-registry.js";
import { createDefaultRegistry } from "@/commands/commands.js";
import { loadUserCommands } from "@/commands/loader.js";
import { RecoveryState } from "@/compact/recovery.js";
import {
  getContextWindow,
  ProviderConfigSchema,
} from "@/config/provider-config.js";
import { ConversationManager } from "@/conversation/index.js";
import { getExecutionContext } from "@/cost/context.js";
import { createCostLedger } from "@/cost/ledger.js";
import { FileHistory } from "@/file-history/index.js";
import { registerProject } from "@/history/index.js";
import { HookEngine, validate as validateHooks } from "@/hooks/index.js";
import { createClient, measureClient } from "@/llm/client.js";
import { createChildLogger } from "@/logger/index.js";
import { MCPManager } from "@/mcp/manager.js";
import {
  DirectoryMCPArtifactStore,
  MCPReadResourceTool,
  MCPResourcesTool,
} from "@/mcp/resources.js";
import { decideAndApply } from "@/mcp/strategy.js";
import { loadInstructions } from "@/memory/instructions.js";
import { MemoryManager } from "@/memory/manager.js";
import { buildSystemPrompt, detectEnvironment } from "@/prompt/builder.js";
import { AgentRuntimeImpl } from "@/runtime/agent-runtime.js";
import { RUNTIME_PROVIDER_PROTOCOL_ERROR } from "@/runtime/constants.js";
import { bindBorrowedMcpView } from "@/runtime/mcp-view.js";
import { configureRuntimeShell } from "@/runtime/preferences.js";
import type { AgentRuntime, CreateRuntimeOptions } from "@/runtime/types.js";
import { newSessionId } from "@/session/index.js";
import { SkillCatalog } from "@/skills/catalog.js";
import { InstallSkillTool } from "@/skills/install-skill-tool.js";
import { LoadSkillTool } from "@/skills/load-skill-tool.js";
import type { SkillForkHost, SkillHost } from "@/skills/types.js";
import { sessionPath } from "@/storage/index.js";
import { AgentTool, type TeammateRunOptions } from "@/subagent/agent-tool.js";
import { BUILTIN_AGENTS } from "@/subagent/constants.js";
import { spawnSubagent, type AgentEventSink } from "@/subagent/spawn.js";
import { TaskManager } from "@/subagent/task-manager.js";
import { TeamManager, type RunAgent } from "@/teams/index.js";
import { TaskStopTool } from "@/teams/task-stop.js";
import {
  TeamCreateTool,
  TeamDeleteTool,
  TeamListTool,
  SendMessageTool,
} from "@/teams/tools.js";
import { TaskList } from "@/todo/index.js";
import { TaskStore } from "@/todo/store.js";
import { AskUserQuestionTool } from "@/tools/ask-user.js";
import { FileStateCache } from "@/tools/file-state-cache.js";
import { ToolRegistry } from "@/tools/registry.js";
import { attachBackgroundTaskManager } from "@/tools/shell-background.js";
import { SyntheticOutputTool } from "@/tools/synthetic-output.js";
import { contentToText } from "@/utils/index.js";
import { attachWorkflow } from "@/workflow/wiring.js";

const log = createChildLogger({ module: "runtime" });

export async function createAgentRuntime(
  opts: CreateRuntimeOptions,
): Promise<AgentRuntime> {
  const {
    provider: configuredProvider,
    cwd,
    enableCoordinatorMode,
    memoryEnabled = true,
    sessionId = newSessionId(),
  } = opts;
  const provider = ProviderConfigSchema.parse(configuredProvider);
  if (
    opts.client?.protocol !== undefined &&
    opts.client.protocol !== provider.protocol
  ) {
    throw new Error(RUNTIME_PROVIDER_PROTOCOL_ERROR);
  }
  const inherited = opts.executionContext ?? getExecutionContext();
  const ledger =
    opts.ledger ??
    inherited?.ledger ??
    createCostLedger({ sessionId, cwd, persist: opts.persist !== false });
  const executionContext =
    inherited?.ledger === ledger
      ? inherited
      : {
          sessionId: ledger.sessionId,
          runId: randomUUID(),
          agentId: "main",
          purpose: "main" as const,
          ledger,
        };
  const hookError = validateHooks(opts.hooks ?? []);
  if (hookError) {
    throw hookError;
  }
  if (opts.persist !== false) {
    registerProject(cwd);
  }
  const taskList = new TaskList(
    opts.persist === false ? undefined : new TaskStore(sessionId),
  );
  const teamManager = new TeamManager(cwd, enableCoordinatorMode);
  const codeMode = opts.preferences?.code_mode ?? opts.codeMode;
  const registry = opts.registry
    ? new ToolRegistry()
    : createToolRegistry(taskList, {
        codeMode,
        enableModelPlanMode: opts.enableModelPlanMode,
        interactionMode: opts.interactionMode ?? "interactive",
        teamManager,
      });
  if (opts.registry) {
    for (const tool of opts.registry.listTools()) {
      registry.registerBorrowed(tool);
    }
    registry.copyLoadingStateFrom(opts.registry);
  }
  registry.setPolicy({
    allowlist: opts.toolNames,
    denylist: opts.exclude,
    codeModeEnabled: codeMode
      ? codeMode.mode !== "off"
      : Boolean(registry.get("CodeMode")),
    codeModeMode: codeMode?.mode,
    codeModeInlineBudget: codeMode?.inline_budget,
  });
  const registerRuntimeTool = (
    tool: Parameters<ToolRegistry["register"]>[0],
  ): void => {
    if (!registry.get(tool.name)) {
      registry.register(tool);
    }
  };
  const backgroundTaskManager = new TaskManager(
    opts.persist === false ? undefined : sessionId,
    cwd,
    opts.persist === false ? null : undefined,
  );
  const mcpManager =
    opts.mcpManager ??
    new MCPManager({
      appsEnabled: true,
      registry,
      authorizeProject: opts.authorizeMcpSource,
    });
  const mcpSource = mcpManager.createSource("global", `runtime:${sessionId}`);
  const refreshMcpTools = opts.mcpManager
    ? bindBorrowedMcpView(mcpManager, registry)
    : undefined;
  let handle: AgentRuntime | undefined;
  const getHandle = (): AgentRuntime => {
    if (!handle) {
      throw new Error("Agent runtime initialization is incomplete");
    }
    return handle;
  };
  try {
    const env = detectEnvironment(cwd, {
      skipGit: opts.loadProjectResources !== true,
    });
    env.model = provider.model;
    const systemPrompt = opts.systemPrompt ?? buildSystemPrompt(env);
    const client = opts.client
      ? measureClient(opts.client, provider)
      : await createClient(provider, systemPrompt);
    if (opts.client && opts.systemPrompt !== undefined) {
      client.setSystemPrompt(systemPrompt);
    }
    const conv = new ConversationManager();
    const memoryManager = new MemoryManager(cwd);
    conv.injectLongTermMemory(
      loadInstructions(cwd),
      memoryEnabled ? memoryManager.buildSystemReminder() : "",
    );
    const hookEngine = new HookEngine(opts.hooks ?? []);
    const catalog = new SkillCatalog();
    catalog.load(cwd, {
      projectPaths: opts.loadProjectResources === false ? [] : opts.skillPaths,
      projectFileDigests: opts.skillFileDigests,
      additionalPaths: opts.additionalSkillPaths,
      disabled: opts.disabledSkills,
    });
    const activeSkills = new Map<string, string>();
    const report = opts.onSubagentEvent;
    const trackSubagent = (
      toolCallId: string,
      role: string,
      background: boolean,
      signal: AbortSignal | undefined,
      run: (onEvent: AgentEventSink) => Promise<string>,
    ): Promise<string> => {
      if (!report) {
        return run(() => undefined);
      }
      report({ toolCallId, role, background, type: "started" });
      const sink: AgentEventSink = (event) => {
        switch (event.type) {
          case "tool_use":
            report({
              toolCallId,
              role,
              background,
              type: "tool_use",
              toolId: event.toolId,
              toolName: event.toolName,
            });
            break;
          case "tool_result":
            report({
              toolCallId,
              role,
              background,
              type: "tool_result",
              toolId: event.toolId,
            });
            break;
          case "turn_complete":
            report({ toolCallId, role, background, type: "turn_complete" });
            break;
          case "usage":
            break;
        }
      };
      return run(sink).then(
        (result) => {
          report({
            toolCallId,
            role,
            background,
            type: "finished",
            status: signal?.aborted ? "stopped" : "completed",
          });
          return result;
        },
        (error: unknown) => {
          report({
            toolCallId,
            role,
            background,
            type: "finished",
            status: signal?.aborted ? "stopped" : "failed",
          });
          throw error;
        },
      );
    };
    const subagentOptions = (id = newSessionId()) => {
      const h = getHandle();
      if (opts.persist === false) {
        h.ownSubagentSession(id);
      }
      return {
        sessionId: id,
        persist: opts.persist,
        cleanupArtifacts: opts.persist !== false,
        executionContext: getExecutionContext() ?? h.executionContext,
      };
    };
    const skillHost: SkillHost = {
      activateSkill: (name, body) => {
        activeSkills.set(name, body);
      },
    };
    const skillForkHost: SkillForkHost = {
      activateSkill: skillHost.activateSkill.bind(skillHost),
      snapshotParentMessages: (count) =>
        conv
          .getMessages()
          .slice(-count)
          .map((m) => `${m.role}: ${contentToText(m.content)}`)
          .join("\n"),
      runSubagent: (prompt, signal, context) => {
        const h = getHandle();
        return spawnSubagent(
          BUILTIN_AGENTS[0],
          prompt,
          h.client,
          registry,
          h.provider,
          cwd,
          undefined,
          undefined,
          undefined,
          context?.permissionChecker?.forCwd(cwd) ?? h.checker.forCwd(cwd),
          {
            ...subagentOptions(),
            abortSignal: signal,
            background: false,
            onPermissionRequest: context?.onPermissionRequest,
          },
        );
      },
    };
    registerRuntimeTool(new LoadSkillTool(catalog, skillHost, skillForkHost));
    if (opts.askUser) {
      registerRuntimeTool(new AskUserQuestionTool(opts.askUser));
    }
    const teamRunAgentFactory = (
      teamRegistry: ToolRegistry,
      teamChecker?: Parameters<typeof spawnSubagent>[9],
      memberCwd = cwd,
      options?: TeammateRunOptions,
    ): RunAgent => {
      const conversation = new ConversationManager();
      const ownedOptions = subagentOptions();
      return (task, onEvent, signal) => {
        const h = getHandle();
        return spawnSubagent(
          options?.definition ?? BUILTIN_AGENTS[0],
          task,
          h.client,
          teamRegistry,
          h.provider,
          memberCwd,
          undefined,
          onEvent,
          options?.modelOverride,
          teamChecker,
          {
            ...ownedOptions,
            abortSignal: signal,
            backgroundTasks: false,
            contextSnapshot: options?.contextSnapshot,
            agentName: options?.agentName,
            conversation,
            onPermissionRequest: options?.onPermissionRequest,
          },
        );
      };
    };
    if (opts.persist !== false && opts.loadProjectResources !== false) {
      teamManager.restoreFromDisk();
    }
    if (!opts.registry) {
      attachBackgroundTaskManager(registry, backgroundTaskManager);
    }
    registerRuntimeTool(new TeamCreateTool(teamManager));
    registerRuntimeTool(new SendMessageTool(teamManager));
    registerRuntimeTool(new TeamDeleteTool(teamManager));
    registerRuntimeTool(new TeamListTool(teamManager));
    registerRuntimeTool(new TaskStopTool(teamManager, backgroundTaskManager));
    registerRuntimeTool(new SyntheticOutputTool());
    const agentTool = new AgentTool(
      cwd,
      registry,
      async (
        def,
        prompt,
        background,
        modelOverride,
        cwdOverride,
        context,
        contextSnapshot,
      ) => {
        const h = getHandle();
        return trackSubagent(
          context?.toolCallId ?? randomUUID(),
          def.name,
          background,
          context?.abortSignal,
          (onEvent) =>
            spawnSubagent(
              def,
              prompt,
              h.client,
              registry,
              h.provider,
              cwdOverride ?? cwd,
              undefined,
              onEvent,
              modelOverride,
              cwdOverride
                ? context?.permissionChecker?.forCwd(cwdOverride)
                : context?.permissionChecker,
              {
                ...subagentOptions(context?.subagentSessionId),
                contextSnapshot,
                abortSignal: context?.abortSignal,
                background,
                onPermissionRequest: context?.onPermissionRequest,
                permissionMode: context?.permissionChecker?.mode,
              },
            ),
        );
      },
      conv,
      backgroundTaskManager,
    );
    agentTool.setTeamManager(teamManager, teamRunAgentFactory);
    registerRuntimeTool(agentTool);
    const workflows = attachWorkflow({
      cwd,
      registry,
      taskManager: backgroundTaskManager,
      persist: opts.persist,
      getClient: () => getHandle().client,
      getProvider: () => getHandle().provider,
    });
    const cmdRegistry = createDefaultRegistry();
    cmdRegistry.register({
      name: "provider",
      type: "local_ui",
      description: "Switch the active provider",
      handler: () => "provider",
    });
    if (opts.loadProjectResources !== false) {
      for (const cmd of loadUserCommands()) {
        if (!cmdRegistry.find(cmd.name)) {
          cmdRegistry.register(cmd);
        }
      }
      await workflows.registerNamedCommands(cmdRegistry);
    }
    wireSkillsToRegistry(catalog, cmdRegistry, skillHost);
    if (opts.loadProjectResources !== false) {
      registerRuntimeTool(
        new InstallSkillTool(cwd, catalog, () => {
          wireSkillsToRegistry(catalog, cmdRegistry, skillHost);
        }),
      );
    }
    registerRuntimeTool(new MCPResourcesTool(mcpManager));
    registerRuntimeTool(
      new MCPReadResourceTool(
        mcpManager,
        new DirectoryMCPArtifactStore(sessionPath(sessionId, "mcp-resources")),
      ),
    );
    if (opts.mcpServers?.length) {
      const result = await mcpManager.connectAll(opts.mcpServers, mcpSource);
      for (const { serverName, error } of result.errors) {
        log.error({ serverName, error }, "MCP server connection error");
      }
      if (result.tools.length) {
        decideAndApply(registry, provider.base_url, provider.protocol);
      }
    }
    await refreshMcpTools?.();
    for (const tool of opts.tools ?? []) {
      registry.unregister(tool.name);
      registry.registerBorrowed(tool);
    }
    if (opts.toolNames || opts.exclude?.length) {
      for (const tool of registry.listTools()) {
        if (
          (opts.toolNames && !opts.toolNames.includes(tool.name)) ||
          opts.exclude?.includes(tool.name)
        ) {
          registry.unregister(tool.name);
        }
      }
    }
    await configureBashSandbox(registry, cwd, opts.sandboxConfig);
    handle = new AgentRuntimeImpl(
      {
        client,
        systemPrompt:
          opts.client && opts.systemPrompt === undefined
            ? undefined
            : systemPrompt,
        conv,
        registry,
        sessionId,
        executionContext,
        fileHistory: new FileHistory(
          sessionId,
          opts.persist !== false,
          opts.onBeforeFileEdit,
        ),
        fileStateCache: new FileStateCache(),
        cmdRegistry,
        skillCatalog: catalog,
        activeSkills,
        toolFilter: null,
        mcpManager,
        mcpSource,
        refreshMcpTools,
        hookEngine,
        recoveryState: new RecoveryState(),
        teamManager,
        backgroundTaskManager,
        enableCoordinatorMode,
        memoryManager,
        memoryEnabled,
        contextWindow: getContextWindow(provider),
        provider,
        cwd,
        taskList,
      },
      opts,
    );
    configureRuntimeShell(handle, opts);
    return handle;
  } catch (error) {
    await Promise.allSettled([
      backgroundTaskManager.stopAll(),
      teamManager.dispose(),
      registry.dispose(),
      opts.mcpManager
        ? mcpManager.unregisterOwner(mcpSource)
        : mcpManager.disconnectAll(),
    ]);
    throw error;
  }
}
