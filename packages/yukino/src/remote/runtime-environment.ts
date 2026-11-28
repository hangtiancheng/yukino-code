import { isDeepStrictEqual } from "node:util";

import {
  resolveInvocationProvider,
  readInvocationText,
} from "@/bootstrap/invocation.js";
import type { InvocationOptions } from "@/cli.js";
import type { AppConfigOverrides } from "@/config/index.js";
import {
  AppConfigSchema,
  inheritConfigMetadata,
  type AppConfig,
} from "@/config/index.js";
import { RuntimePreferencesSchema } from "@/config/preferences.js";
import type { ConnectResult } from "@/mcp/manager.js";
import { initializeMCPServers } from "@/mcp/startup.js";
import { decideAndApply } from "@/mcp/strategy.js";
import { PermissionChecker } from "@/permissions/index.js";
import { resolveProjectConfig } from "@/project/index.js";
import type {
  AuthorizedProject,
  ProjectContext,
  ProjectTrustRequest,
  TrustDecision,
} from "@/project/types.js";
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
import type { AgentRuntime, CreateRuntimeOptions } from "@/runtime/types.js";
import type { SessionManager } from "@/session/manager.js";
import type { SessionRuntimeState } from "@/session/records.js";
import { cancelOnSignal } from "@/utils/cancel.js";
import { canonicalPath } from "@/utils/paths.js";

export interface RuntimeEnvironment {
  config: AppConfig;
  runtime: AgentRuntime;
  project: ProjectContext;
  projectAccess: { current: ProjectContext };
  lifecycleGuard: () => string | undefined;
  manager: SessionManager;
  errors: ConnectResult["errors"];
  state: SessionRuntimeState;
  droppedDeclarations: string[];
}

export async function createRuntimeEnvironment(
  global: Partial<AppConfig>,
  manager: SessionManager,
  options: Omit<CreateRuntimeOptions, "cwd" | "provider"> & {
    invocationOptions?: InvocationOptions;
    authorizedProject?: AuthorizedProject;
    overrides?: AppConfigOverrides;
    configSource?: object;
    restoreState?: boolean;
    signal?: AbortSignal;
    onTrustRequest?: (request: ProjectTrustRequest) => Promise<TrustDecision>;
    factory?: typeof createAgentRuntime;
  },
): Promise<RuntimeEnvironment> {
  options.signal?.throwIfAborted();
  const invocation = options.invocationOptions ?? {};
  const onTrustRequest = options.onTrustRequest;
  const { config, project } = await resolveProjectConfig(
    manager.cwd,
    inheritConfigMetadata(
      options.configSource ?? global,
      AppConfigSchema.parse(global),
    ),
    {
      trust:
        invocation.trustProject &&
        canonicalPath(invocation.cwd ?? process.cwd()) === manager.cwd
          ? "once"
          : undefined,
      authorizedProject: options.authorizedProject,
      overrides: options.overrides,
      disabled: invocation.noProjectResources,
      onTrustRequest: onTrustRequest
        ? (request) =>
            cancelOnSignal(() => onTrustRequest(request), options.signal)
        : undefined,
    },
  );
  const projectAccess = { current: project };
  const lifecycleGuard = () =>
    options.signal?.aborted ? "host_exit" : options.cacheGuard?.();
  let runtime: AgentRuntime | undefined;
  const errors: RuntimeEnvironment["errors"] = [];
  try {
    options.signal?.throwIfAborted();
    manager.refresh();
    const restoreState =
      options.restoreState ??
      (invocation.provider === undefined &&
        invocation.model === undefined &&
        invocation.thinking === undefined);
    const saved = restoreState ? manager.getRuntimeState() : null;
    const provider = saved
      ? resolveSessionProvider(saved, config)
      : resolveInvocationProvider(
          config.providers,
          config.default_provider,
          invocation,
        );
    const initiallyTrusted = project.trusted;
    const cacheGuard = () => {
      if (options.signal?.aborted) {
        return "host_exit";
      }
      if (initiallyTrusted && !projectAccess.current.trusted) {
        return "trust_revoked";
      }
      return options.cacheGuard?.();
    };
    let systemPrompt = invocation.systemPrompt ?? options.systemPrompt;
    if (invocation.systemPromptFile) {
      systemPrompt = await readInvocationText(
        invocation.systemPromptFile,
        manager.cwd,
      );
    }
    if (invocation.appendSystemPromptFile) {
      const { buildSystemPrompt, detectEnvironment } =
        await import("@/prompt/builder.js");
      const env = detectEnvironment(manager.cwd);
      env.model = provider.model;
      systemPrompt =
        (systemPrompt ?? buildSystemPrompt(env)) +
        "\n\n" +
        (await readInvocationText(
          invocation.appendSystemPromptFile,
          manager.cwd,
        ));
    }
    runtime = await (options.factory ?? createAgentRuntime)({
      ...options,
      cwd: manager.cwd,
      provider,
      systemPrompt,
      cacheGuard,
      sessionId: manager.id,
      persist: manager.persistent,
      cleanupArtifacts: false,
      checker:
        options.checker?.forCwd(manager.cwd) ??
        new PermissionChecker(
          manager.cwd,
          invocation.permissionMode ?? config.permission_mode ?? "default",
        ),
      hooks: config.hooks,
      sandboxConfig: config.sandbox,
      codeMode: config.code_mode,
      preferences: RuntimePreferencesSchema.parse(config),
      ...projectSkillOptions(project),
      additionalSkillPaths: global.skills?.paths,
      disabledSkills: config.skills?.disabled,
      shellPath: config.shellPath,
      shellCommandPrefix: config.shellCommandPrefix,
      enableCoordinatorMode: config.enable_coordinator_mode ?? false,
      memoryEnabled: config.enable_memory,
      loadProjectResources: project.trusted,
      toolNames: invocation.tools ?? options.toolNames,
      exclude: invocation.excludeTools ?? options.exclude,
      mcpServers: [],
      authorizeMcpSource: (source) =>
        projectAccess.current.trusted &&
        source.projectRoot === projectAccess.current.cwd,
    });
    options.signal?.throwIfAborted();
    const mcp = runtime.mcpManager;
    if (mcp) {
      errors.push(
        ...(await initializeMCPServers(
          mcp,
          runtime.mcpSource,
          project,
          config.mcp_servers,
          { signal: options.signal },
        )),
      );
      await runtime.refreshMcpTools?.();
      decideAndApply(runtime.registry, provider.base_url, provider.protocol);
    }
    const droppedDeclarations = saved
      ? restoreSessionDeclarations(
          runtime,
          saved,
          project,
          invocation.tools !== undefined ||
            invocation.excludeTools !== undefined ||
            options.toolNames !== undefined ||
            options.exclude !== undefined,
        )
      : [];
    if (provider.thinking !== undefined && runtime.client.setThinkingLevel) {
      runtime.setThinking(provider.thinking);
    }
    await runtime.cache.invalidate("branch_change");
    for (const name of [
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
      "warming",
    ]) {
      if (!runtime.cmdRegistry.find(name)) {
        runtime.cmdRegistry.register({
          name,
          type: "local_ui",
          description: `Session ${name}`,
          handler: () => name,
        });
      }
    }
    await reloadRuntimeCommands(runtime, project);
    options.signal?.throwIfAborted();
    runtime.conv.reset();
    runtime.conv.appendMessages(manager.getMessages());
    if (invocation.name) {
      manager.setName(invocation.name);
    }
    const goal = manager.getEntries().length ? runtime.goalManager : undefined;
    if (goal?.get()?.status === "active") {
      goal.transition("paused");
      manager.refresh();
    }
    options.signal?.throwIfAborted();
    const state = captureSessionRuntimeState(runtime, project);
    const pending = new Set<string>();
    for (const message of runtime.conv.getMessages()) {
      for (const tool of message.toolUses ?? []) {
        pending.add(tool.toolUseId);
      }
      for (const result of message.toolResults ?? []) {
        pending.delete(result.toolUseId);
      }
    }
    if (!pending.size && !isDeepStrictEqual(manager.getRuntimeState(), state)) {
      manager.appendRuntimeState(state);
    }
    return {
      runtime,
      project,
      projectAccess,
      lifecycleGuard,
      config,
      manager,
      errors,
      state,
      droppedDeclarations,
    };
  } catch (error) {
    await Promise.allSettled([runtime?.dispose(), project.dispose()]);
    throw error;
  }
}
