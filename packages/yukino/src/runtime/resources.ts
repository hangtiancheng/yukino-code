import { wireSkillsToRegistry } from "@/bootstrap/tool-registry.js";
import type { AppConfig } from "@/config/index.js";
import { RuntimePreferencesSchema } from "@/config/preferences.js";
import { HookEngine, validate as validateHooks } from "@/hooks/index.js";
import { initializeMCPServers } from "@/mcp/startup.js";
import { decideAndApply } from "@/mcp/strategy.js";
import { loadInstructions } from "@/memory/instructions.js";
import { resolveProjectConfig } from "@/project/index.js";
import type { ProjectContext, ResolveProjectOptions } from "@/project/types.js";
import {
  RUNTIME_RELOAD_BUSY_ERROR,
  RUNTIME_RELOAD_FAILED_ERROR,
} from "@/runtime/constants.js";
import {
  applyRuntimePreferences,
  configureRuntimeShell,
} from "@/runtime/preferences.js";
import { buildReloadReminder } from "@/runtime/prompts.js";
import type { AgentRuntime, CreateRuntimeOptions } from "@/runtime/types.js";
import { InstallSkillTool } from "@/skills/install-skill-tool.js";
import { cancelOnSignal } from "@/utils/cancel.js";
import { asErrorString } from "@/utils/index.js";
import { getWorkflowService } from "@/workflow/wiring.js";

export interface ResourceEnvironment {
  runtime: AgentRuntime;
  project: ProjectContext;
  config: AppConfig;
  projectAccess: { current: ProjectContext };
  lifecycleGuard?: () => string | undefined;
}

export function projectSkillOptions(
  project: ProjectContext,
): Pick<CreateRuntimeOptions, "skillPaths" | "skillFileDigests"> {
  return {
    skillPaths: project.getResourcePaths("skills"),
    skillFileDigests: new Map(
      project.manifest
        .filter((entry) => entry.kind === "skills")
        .map((entry) => [entry.path, entry.digest]),
    ),
  };
}

async function applyResources(
  environment: ResourceEnvironment,
  global: AppConfig,
): Promise<void> {
  const { runtime, project, config } = environment;
  const { skillPaths, skillFileDigests } = projectSkillOptions(project);
  runtime.hookEngine = new HookEngine(config.hooks);
  runtime.skillCatalog?.load(runtime.cwd, {
    projectPaths: skillPaths,
    projectFileDigests: skillFileDigests,
    additionalPaths: global.skills?.paths,
    disabled: config.skills?.disabled,
  });
  runtime.activeSkills.clear();
  applyRuntimePreferences(runtime, RuntimePreferencesSchema.parse(config));
  configureRuntimeShell(runtime, config);
  await reloadRuntimeCommands(runtime, project);
  if (
    project.trusted &&
    runtime.skillCatalog &&
    !runtime.registry.get("InstallSkill")
  ) {
    const catalog = runtime.skillCatalog;
    runtime.registry.register(
      new InstallSkillTool(runtime.cwd, catalog, () => {
        wireSkillsToRegistry(catalog, runtime.cmdRegistry, {
          activateSkill: (name, body) => runtime.activeSkills.set(name, body),
        });
      }),
    );
  } else if (
    !project.trusted &&
    runtime.registry.getInstanceOf("InstallSkill", InstallSkillTool)
  ) {
    runtime.registry.unregister("InstallSkill");
  }
}

export async function reloadRuntimeCommands(
  runtime: AgentRuntime,
  project: ProjectContext,
): Promise<void> {
  runtime.cmdRegistry.removeResources();
  for (const command of await project.loadCommands()) {
    if (!runtime.cmdRegistry.find(command.name)) {
      runtime.cmdRegistry.register(command);
    }
  }
  if (runtime.skillCatalog) {
    wireSkillsToRegistry(runtime.skillCatalog, runtime.cmdRegistry, {
      activateSkill: (name, body) => runtime.activeSkills.set(name, body),
    });
  }
  if (project.trusted) {
    await getWorkflowService(runtime.registry)?.registerNamedCommands(
      runtime.cmdRegistry,
    );
  }
}

export async function reloadRuntimeResources(
  environment: ResourceEnvironment,
  global: AppConfig,
  options: ResolveProjectOptions & { signal?: AbortSignal } = {},
) {
  const { runtime } = environment;
  if (runtime.backgroundTaskManager.hasRunning()) {
    throw new Error(RUNTIME_RELOAD_BUSY_ERROR);
  }
  options.signal?.throwIfAborted();
  const onTrustRequest = options.onTrustRequest;
  let candidate: ProjectContext | undefined;
  let replaced = false;
  try {
    const next = await resolveProjectConfig(runtime.cwd, global, {
      ...options,
      onTrustRequest: onTrustRequest
        ? (request) =>
            cancelOnSignal(() => onTrustRequest(request), options.signal)
        : undefined,
      authorizedProject: environment.project.trusted
        ? {
            identity: environment.project.identity,
            fingerprint: environment.project.fingerprint,
          }
        : undefined,
    });
    candidate = next.project;
    options.signal?.throwIfAborted();
    const hookError = validateHooks(next.config.hooks);
    if (hookError) {
      throw hookError;
    }
    await runtime.cache.invalidate("branch_change");
    options.signal?.throwIfAborted();
    const previous = environment.project;
    environment.project = next.project;
    environment.projectAccess.current = next.project;
    environment.config = next.config;
    candidate = undefined;
    replaced = true;
    await previous.dispose();
    if (runtime.mcpManager && runtime.mcpSource) {
      await runtime.mcpManager.unregisterOwner(runtime.mcpSource);
      runtime.mcpSource = runtime.mcpManager.createSource(
        "global",
        `reload:${runtime.sessionId}`,
      );
    }
    const initiallyTrusted = next.project.trusted;
    runtime.cache.setGuard(
      () =>
        environment.lifecycleGuard?.() ??
        (initiallyTrusted && !environment.projectAccess.current.trusted
          ? "trust_revoked"
          : undefined),
    );
    await applyResources(environment, global);
    const errors = runtime.mcpManager
      ? await initializeMCPServers(
          runtime.mcpManager,
          runtime.mcpSource,
          next.project,
          next.config.mcp_servers,
          { signal: options.signal },
        )
      : [];
    await runtime.refreshMcpTools?.();
    decideAndApply(
      runtime.registry,
      runtime.provider.base_url,
      runtime.provider.protocol,
    );
    runtime.conv.addSystemReminder(
      buildReloadReminder(
        loadInstructions(runtime.cwd),
        runtime.skillCatalog?.list().map((skill) => skill.name) ?? [],
      ),
    );
    return {
      skills: runtime.skillCatalog?.list().length ?? 0,
      commands: runtime.cmdRegistry.listCommands().length,
      errors,
    };
  } catch (error) {
    const failures = [error];
    if (candidate) {
      try {
        await candidate.dispose();
      } catch (failure) {
        failures.push(failure);
      }
    }
    // Discovery can revoke the previous grant before it throws.
    if (replaced || !environment.project.trusted) {
      for (const cleanup of [
        () => environment.project.dispose(),
        () => applyResources(environment, global),
        () => runtime.refreshMcpTools?.(),
      ]) {
        try {
          await cleanup();
        } catch (failure) {
          if (!failures.includes(failure)) {
            failures.push(failure);
          }
        }
      }
      runtime.cache.setGuard(() => environment.lifecycleGuard?.());
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `${RUNTIME_RELOAD_FAILED_ERROR}: ${failures.map(asErrorString).join("; ")}`,
      );
    }
    throw error;
  }
}
