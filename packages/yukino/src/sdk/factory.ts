import { realpath, stat } from "node:fs/promises";

import { resolveInvocationProvider } from "@/bootstrap/invocation.js";
import type { SessionRequestTracker } from "@/cache/requests.js";
import type { CacheWarmingScheduler } from "@/cache/warming.js";
import {
  AppConfigSchema,
  loadConfig,
  inheritConfigMetadata,
  type AppConfig,
} from "@/config/index.js";
import { RuntimePreferencesSchema } from "@/config/preferences.js";
import {
  resolveDefaultProvider,
  type ProviderConfig,
} from "@/config/provider-config.js";
import { createCostLedger, type ExecutionLedger } from "@/cost/ledger.js";
import { measureClient, type LLMClient } from "@/llm/client.js";
import { initializeMCPServers } from "@/mcp/startup.js";
import { decideAndApply } from "@/mcp/strategy.js";
import { PermissionChecker } from "@/permissions/index.js";
import { loadPlan } from "@/plan-file/index.js";
import { resolveProjectConfig } from "@/project/index.js";
import type { ProjectContext, ResolveProjectOptions } from "@/project/types.js";
import { createAgentRuntime } from "@/runtime/factory.js";
import {
  projectSkillOptions,
  reloadRuntimeCommands,
} from "@/runtime/resources.js";
import {
  captureSessionRuntimeState,
  resolveSessionProvider,
  restoreSessionDeclarations,
} from "@/runtime/session-state.js";
import type { AgentRuntime } from "@/runtime/types.js";
import { AgentSession } from "@/sdk/agent-session.js";
import {
  CUSTOM_PROVIDER,
  SDK_CLIENT_REQUIRED_ERROR,
  SDK_MODEL_TARGET_ERROR,
  SDK_NO_APPROVAL_ERROR,
} from "@/sdk/constants.js";
import type { CreateAgentSessionOptions } from "@/sdk/types.js";
import { SessionManager } from "@/session/manager.js";
import type { SessionRuntimeState } from "@/session/records.js";
import type { Tool } from "@/tools/types.js";
import { cancelOnSignal } from "@/utils/cancel.js";

export interface SessionEnvironment {
  config: AppConfig;
  runtime: AgentRuntime;
  project: ProjectContext;
  projectAccess: { current: ProjectContext };
  lifecycleGuard: () => string | undefined;
  ledger: ExecutionLedger;
  warming: CacheWarmingScheduler;
  requests: SessionRequestTracker;
  client?: LLMClient;
  state: SessionRuntimeState;
  droppedDeclarations: string[];
}

interface SessionEnvironmentOptions extends Pick<
  ResolveProjectOptions,
  "authorizedProject"
> {
  restoreState?: boolean;
  loadGlobalConfig?: boolean;
  declarations?: SessionRuntimeState;
  signal?: AbortSignal;
  providerForState?: (state: SessionRuntimeState) => ProviderConfig | undefined;
  clientForProvider?: (provider: ProviderConfig) => LLMClient | undefined;
}

export function sdkConfig(options: CreateAgentSessionOptions): AppConfig {
  const provider =
    options.provider ??
    (options.client
      ? {
          ...CUSTOM_PROVIDER,
          protocol: options.client.protocol ?? CUSTOM_PROVIDER.protocol,
        }
      : undefined);
  const global = options.config?.providers
    ? inheritConfigMetadata(
        options.config,
        AppConfigSchema.parse(options.config),
      )
    : options.configPath
      ? loadConfig(options.configPath)
      : !provider
        ? loadConfig()
        : inheritConfigMetadata(
            { providers: [provider] },
            AppConfigSchema.parse({ providers: [provider] }),
          );
  return inheritConfigMetadata(
    global,
    AppConfigSchema.parse({
      ...global,
      ...options.config,
      mcp_servers:
        options.mcpServers ?? options.config?.mcp_servers ?? global.mcp_servers,
      enable_memory: options.config?.enable_memory ?? false,
    }),
  );
}

export async function buildSessionEnvironment(
  options: CreateAgentSessionOptions,
  manager: SessionManager,
  onSubagentEvent: NonNullable<
    Parameters<typeof createAgentRuntime>[0]["onSubagentEvent"]
  >,
  environmentOptions: SessionEnvironmentOptions = {},
): Promise<SessionEnvironment> {
  const signal =
    environmentOptions.signal && options.signal
      ? AbortSignal.any([environmentOptions.signal, options.signal])
      : (environmentOptions.signal ?? options.signal);
  signal?.throwIfAborted();
  manager.refresh();
  const restoreState =
    environmentOptions.restoreState ??
    (options.provider === undefined &&
      options.model === undefined &&
      options.thinking === undefined &&
      options.client === undefined);
  const saved = restoreState ? manager.getRuntimeState() : null;
  const global = sdkConfig(
    environmentOptions.loadGlobalConfig
      ? { ...options, provider: undefined, client: undefined }
      : options,
  );
  const { onTrustRequest, askUser, planApproval } = options;
  const { config, project } = await resolveProjectConfig(manager.cwd, global, {
    trust: options.trust,
    authorizedProject: environmentOptions.authorizedProject,
    onTrustRequest: onTrustRequest
      ? (request) => cancelOnSignal(() => onTrustRequest(request), signal)
      : undefined,
    overrides: options.overrides,
    disabled: options.disabled,
  });
  const projectAccess = { current: project };
  const lifecycleGuard = () => (signal?.aborted ? "host_exit" : undefined);
  let runtime: AgentRuntime | undefined;
  try {
    signal?.throwIfAborted();
    const selected =
      options.provider ??
      resolveDefaultProvider(config.providers, config.default_provider);
    if (!selected) {
      throw new Error(SDK_CLIENT_REQUIRED_ERROR);
    }
    const fallback =
      saved &&
      !config.providers.some(
        (candidate) => candidate.name === saved.provider.name,
      )
        ? environmentOptions.providerForState?.(saved)
        : undefined;
    const provider = saved
      ? resolveSessionProvider(saved, config, fallback)
      : resolveInvocationProvider([selected], 0, {
          model: options.model,
          thinking: options.thinking,
        });
    const suppliedClient = saved
      ? environmentOptions.clientForProvider?.(provider)
      : options.client;
    if (!provider.base_url && !suppliedClient) {
      throw new Error(SDK_MODEL_TARGET_ERROR);
    }
    const checker =
      options.permissions instanceof PermissionChecker
        ? options.permissions.forCwd(manager.cwd)
        : new PermissionChecker(manager.cwd, options.permissions ?? "default");
    const client = suppliedClient
      ? measureClient(suppliedClient, provider)
      : undefined;
    const ledger =
      options.ledger?.sessionId === manager.id
        ? options.ledger
        : createCostLedger({
            sessionId: manager.id,
            cwd: manager.cwd,
            persist: manager.persistent,
          });
    runtime = await createAgentRuntime({
      provider,
      client,
      ledger,
      cwd: manager.cwd,
      systemPrompt: options.systemPrompt,
      sessionId: manager.id,
      persist: manager.persistent,
      cleanupArtifacts: false,
      trackFileChanges: options.trackFileChanges ?? false,
      onBeforeFileEdit: options.onBeforeFileEdit,
      authorizeMcpSource: (source) =>
        source.scope === "runtime" ||
        (projectAccess.current.trusted &&
          source.projectRoot === projectAccess.current.cwd),
      registry: options.registry,
      tools: options.tools?.filter(
        (tool): tool is Tool => typeof tool !== "string",
      ),
      toolNames: options.tools
        ? options.tools.map((tool) =>
            typeof tool === "string" ? tool : tool.name,
          )
        : undefined,
      exclude: options.exclude,
      checker,
      mcpManager: options.mcpManager,
      mcpServers: [],
      hooks: config.hooks,
      sandboxConfig: config.sandbox,
      enableCoordinatorMode: config.enable_coordinator_mode ?? false,
      codeMode: config.code_mode,
      preferences: RuntimePreferencesSchema.parse(config),
      ...projectSkillOptions(project),
      additionalSkillPaths: global.skills?.paths,
      disabledSkills: config.skills?.disabled,
      shellPath: config.shellPath,
      shellCommandPrefix: config.shellCommandPrefix,
      enableModelPlanMode: true,
      interactionMode: "non-interactive",
      memoryEnabled: config.enable_memory ?? false,
      loadProjectResources: project.trusted,
      askUser: askUser
        ? (questions, signal) =>
            cancelOnSignal(() => askUser(questions, signal), signal)
        : undefined,
      onSubagentEvent,
    });
    const mcp = runtime.mcpManager;
    if (mcp) {
      await initializeMCPServers(
        mcp,
        runtime.mcpSource,
        project,
        config.mcp_servers,
        { signal },
      );
      await runtime.refreshMcpTools?.();
      decideAndApply(runtime.registry, provider.base_url, provider.protocol);
    }
    await reloadRuntimeCommands(runtime, project);
    const declarations = saved ?? environmentOptions.declarations;
    const droppedDeclarations = declarations
      ? restoreSessionDeclarations(
          runtime,
          declarations,
          project,
          options.tools !== undefined || options.exclude !== undefined,
        )
      : [];
    runtime.conv.reset();
    runtime.conv.appendMessages(manager.getMessages());
    if (provider.thinking !== undefined && runtime.client.setThinkingLevel) {
      runtime.setThinking(provider.thinking);
    }
    const exitPlan = runtime.registry.get("ExitPlanMode");
    if (exitPlan) {
      const original = exitPlan;
      runtime.registry.unregister(original.name);
      runtime.registry.registerBorrowed({
        name: original.name,
        description: original.description,
        category: original.category,
        schema: () => original.schema(),
        execute: async (ctx, args) => {
          const result = await original.execute(ctx, args);
          if (
            result.isError ||
            ctx.permissionChecker?.isSubagent ||
            ctx.permissionChecker?.teammate
          ) {
            return result;
          }
          if (!planApproval) {
            return { output: SDK_NO_APPROVAL_ERROR, isError: true };
          }
          const choice = await cancelOnSignal(
            () =>
              planApproval({
                plan: loadPlan(checker) ?? "",
                sessionId: manager.id,
                signal: ctx.abortSignal,
              }),
            ctx.abortSignal,
          );
          if (choice === "approve") {
            checker.exitPlanMode();
            return result;
          }
          return {
            output:
              typeof choice === "object"
                ? choice.feedback
                : "Plan approval denied",
            isError: true,
          };
        },
      });
    }
    signal?.throwIfAborted();
    const initiallyTrusted = project.trusted;
    runtime.cache.setGuard(() => {
      if (options.signal?.aborted) {
        return "host_exit";
      }
      if (initiallyTrusted && !projectAccess.current.trusted) {
        return "trust_revoked";
      }
      return undefined;
    });
    const { requests, warming } = runtime.cache;
    return {
      config,
      projectAccess,
      lifecycleGuard,
      runtime,
      project,
      ledger,
      warming,
      requests,
      client: suppliedClient,
      state: captureSessionRuntimeState(runtime, project),
      droppedDeclarations,
    };
  } catch (error) {
    await Promise.allSettled([
      Promise.resolve().then(() => runtime?.dispose()),
      Promise.resolve().then(() => project.dispose()),
    ]);
    throw error;
  }
}

export async function createAgentSession(
  options: CreateAgentSessionOptions = {},
): Promise<{ session: AgentSession; sessionManager: SessionManager }> {
  options.signal?.throwIfAborted();
  const cwd = await realpath(
    options.cwd ?? options.sessionManager?.cwd ?? process.cwd(),
  );
  if (!(await stat(cwd)).isDirectory()) {
    throw new Error("Session cwd must be a directory");
  }
  const manager =
    options.sessionManager ??
    SessionManager.create(cwd, { persist: options.persist });
  if (manager.cwd !== cwd) {
    throw new Error("SessionManager cwd does not match session cwd");
  }
  const session = await AgentSession.create(options, manager);
  return { session, sessionManager: manager };
}
