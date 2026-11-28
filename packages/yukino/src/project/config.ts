import { dirname, resolve } from "node:path";

import { THINKING_LEVELS } from "@/config/constants.js";
import type { AppConfigOverrides } from "@/config/index.js";
import {
  AppConfigSchema,
  cloneAppConfig,
  ConfigError,
  getConfigExplicitFields,
  getConfigSourcePath,
  HookConfigSchema,
  ProjectMcpServerConfigSchema,
  validateMcpServers,
  type AppConfig,
  type ProjectConfig,
} from "@/config/index.js";
import {
  ProviderConfigSchema,
  withProviderDefaults,
  type ProviderConfig,
} from "@/config/provider-config.js";
import type { MCPServerConfig } from "@/mcp/config.js";
import {
  CREDENTIAL_REFERENCE_ERROR,
  ENV_REFERENCE_RE,
  PROJECT_ERRORS,
  SAFE_CHILD_ENV_KEYS,
} from "@/project/constants.js";
import type { ProjectDiscovery, ProjectSource } from "@/project/types.js";

function selectedIndex(
  config: AppConfig,
  selection: { provider?: string; default_provider?: number },
): number {
  const index =
    selection.provider === undefined
      ? (selection.default_provider ?? config.default_provider)
      : config.providers.findIndex(
          (provider) => provider.name === selection.provider,
        );
  if (
    index < 0 ||
    (config.providers.length > 0 && index >= config.providers.length)
  ) {
    throw new ConfigError(PROJECT_ERRORS.providerMissing);
  }
  return index;
}

function applySelection(
  config: AppConfig,
  selection: Pick<
    ProjectConfig,
    | "provider"
    | "default_provider"
    | "model"
    | "endpoint"
    | "thinking"
    | "limits"
  >,
): void {
  config.default_provider = selectedIndex(config, selection);
  const provider = config.providers[config.default_provider];
  if (!provider) {
    if (selection.model || selection.endpoint) {
      throw new ConfigError(PROJECT_ERRORS.providerRequired);
    }
    return;
  }
  config.providers[config.default_provider] = withProviderDefaults({
    ...providerForTarget(provider, {
      model: selection.model,
      base_url: selection.endpoint,
    }),
    ...(selection.model !== undefined ? { model: selection.model } : {}),
    ...(selection.endpoint !== undefined
      ? { base_url: selection.endpoint }
      : {}),
    ...(selection.thinking !== undefined
      ? { thinking: selection.thinking }
      : {}),
    ...(selection.limits?.context_window !== undefined
      ? { context_window: selection.limits.context_window }
      : {}),
    ...(selection.limits?.max_output_tokens !== undefined
      ? { max_output_tokens: selection.limits.max_output_tokens }
      : {}),
  });
}

function namedMerge<T>(
  global: T[],
  project: T[],
  nameOf: (value: T) => string,
  disabled: (value: T) => boolean,
): T[] {
  const byName = new Map(global.map((value) => [nameOf(value), value]));
  const seen = new Set<string>();
  for (const value of project) {
    const name = nameOf(value);
    if (seen.has(name)) {
      throw new ConfigError(PROJECT_ERRORS.duplicateResource);
    }
    seen.add(name);
    if (disabled(value)) {
      byName.delete(name);
    } else {
      byName.set(name, value);
    }
  }
  return [...byName.values()];
}

function expandProjectValue(
  value: string,
  environment: Record<string, string>,
  safe: Record<string, string>,
): string {
  const expanded = value.replace(
    ENV_REFERENCE_RE,
    (
      _match,
      braced: string | undefined,
      fallback: string | undefined,
      bare: string | undefined,
    ) => {
      const name = braced ?? bare ?? "";
      const result =
        (Object.hasOwn(environment, name) ? environment[name] : undefined) ??
        (Object.hasOwn(safe, name) ? safe[name] : undefined) ??
        fallback;
      if (result === undefined) {
        throw new ConfigError(CREDENTIAL_REFERENCE_ERROR);
      }
      return result;
    },
  );
  if (new RegExp(ENV_REFERENCE_RE).test(expanded)) {
    throw new ConfigError(CREDENTIAL_REFERENCE_ERROR);
  }
  return expanded;
}

export function prepareProjectMcpServer(
  server: MCPServerConfig,
  cwd: string,
  projectEnv: Record<string, string> = {},
): MCPServerConfig {
  const parsed = ProjectMcpServerConfigSchema.safeParse(server);
  if (!parsed.success) {
    throw new ConfigError(PROJECT_ERRORS.invalidMcp);
  }
  if (server.enabled === false) {
    return { name: server.name, enabled: false };
  }
  const safe = Object.fromEntries(
    SAFE_CHILD_ENV_KEYS.flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key] ?? ""]],
    ),
  );
  const own = { ...projectEnv, ...server.env };
  const environment = Object.fromEntries(
    Object.entries(own).map(([key, value]) => [
      key,
      expandProjectValue(value, projectEnv, safe),
    ]),
  );
  const expand = (value: string) =>
    expandProjectValue(value, environment, safe);
  const prepared = {
    ...parsed.data,
    command: server.command === undefined ? undefined : expand(server.command),
    args: server.args?.map(expand),
    url: server.url === undefined ? undefined : expand(server.url),
    headers:
      server.headers &&
      Object.fromEntries(
        Object.entries(server.headers).map(([key, value]) => [
          key,
          expand(value),
        ]),
      ),
    env: server.command ? { ...safe, ...environment } : undefined,
    inherit_env: false,
    cwd,
  };
  validateMcpServers({ mcp_servers: [prepared] });
  if (prepared.url) {
    let url;
    try {
      url = new URL(prepared.url);
    } catch {
      throw new ConfigError(PROJECT_ERRORS.invalidMcpUrl);
    }
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      throw new ConfigError(PROJECT_ERRORS.unsafeMcpUrl);
    }
  }
  return prepared;
}

export function mergeProjectConfig(
  globalConfig: AppConfig,
  discovery: ProjectDiscovery,
  overrides: AppConfigOverrides,
  trusted: boolean,
): {
  config: AppConfig;
  sources: ProjectSource[];
  projectServers: MCPServerConfig[];
} {
  let config = AppConfigSchema.parse(cloneAppConfig(globalConfig));
  const sourceMap = new Map<string, ProjectSource>();
  const explicitFields = getConfigExplicitFields(globalConfig);
  for (const field of Object.keys(config)) {
    if (config[field] === undefined) {
      continue;
    }
    const explicit = explicitFields
      ? explicitFields.includes(field)
      : Object.hasOwn(globalConfig, field);
    sourceMap.set(field, {
      field,
      scope: explicit ? "global" : "default",
      path: explicit ? getConfigSourcePath(globalConfig) : undefined,
    });
  }
  const project = discovery.config;
  let projectServers: MCPServerConfig[] = [];
  if (trusted) {
    const {
      providers,
      mcp_servers: _mcp,
      hooks,
      env: _env,
      extensions,
      ...preferences
    } = project;
    config = {
      ...config,
      ...preferences,
      code_mode: { ...config.code_mode, ...preferences.code_mode },
      display: { ...config.display, ...preferences.display },
    };
    for (const field of Object.keys(project)) {
      if (field !== "env") {
        sourceMap.set(field, {
          field,
          scope: "project",
          path: discovery.configPath,
        });
      }
    }
    if (providers !== undefined) {
      const seen = new Set<string>();
      config.providers = providers.map((selection) => {
        if (seen.has(selection.name)) {
          throw new ConfigError(PROJECT_ERRORS.duplicateProvider);
        }
        seen.add(selection.name);
        const existing = globalConfig.providers.find(
          (provider) => provider.name === selection.name,
        );
        const inherited = existing && providerForTarget(existing, selection);
        const samplingByLevel = {
          ...inherited?.sampling_params_by_thinking_level,
        };
        for (const level of THINKING_LEVELS) {
          const params = selection.sampling_params_by_thinking_level?.[level];
          if (params) {
            samplingByLevel[level] = {
              ...samplingByLevel[level],
              ...params,
            };
          }
        }
        const parsed = ProviderConfigSchema.safeParse({
          ...(inherited ?? { api_key: "" }),
          ...selection,
          ...(selection.sampling_params
            ? {
                sampling_params: {
                  ...inherited?.sampling_params,
                  ...selection.sampling_params,
                },
              }
            : {}),
          ...(selection.sampling_params_by_thinking_level
            ? { sampling_params_by_thinking_level: samplingByLevel }
            : {}),
        });
        if (!parsed.success) {
          throw new ConfigError(PROJECT_ERRORS.incompleteProvider);
        }
        return withProviderDefaults(parsed.data);
      });
    }
    applySelection(config, project);
    projectServers = discovery.mcpServers.map((server) =>
      prepareProjectMcpServer(server, discovery.cwd, project.env),
    );
    config.mcp_servers = namedMerge(
      config.mcp_servers,
      projectServers,
      (server) => server.name,
      (server) => server.enabled === false,
    );
    if (discovery.mcpServers.length) {
      sourceMap.set("mcp_servers", {
        field: "mcp_servers",
        scope: "project",
        path:
          discovery.manifest.find((entry) => entry.kind === "mcp")?.path ??
          discovery.configPath,
      });
    }
    if (hooks !== undefined) {
      const merged = namedMerge<(typeof hooks)[number]>(
        config.hooks.map((hook, index) => ({
          ...hook,
          id: hook.id ?? `global:${index}`,
        })),
        hooks,
        (hook) => hook.id,
        (hook) => "enabled" in hook && hook.enabled === false,
      );
      config.hooks = merged.map((hook) => HookConfigSchema.parse(hook));
    }
    if (extensions !== undefined) {
      config.extensions = namedMerge(
        config.extensions ?? [],
        extensions,
        (extension) => extension.name,
        (extension) => extension.enabled === false,
      );
      config.extensions = config.extensions.map((extension) => ({
        ...extension,
        path:
          extension.path &&
          resolve(dirname(discovery.configPath), extension.path),
      }));
    }
    if (project.prompts?.paths !== undefined) {
      config.prompts = {
        ...project.prompts,
        paths: discovery.resources.prompts,
      };
    }
  }
  config = AppConfigSchema.parse({
    ...config,
    ...structuredClone(overrides),
    code_mode: { ...config.code_mode, ...overrides.code_mode },
    display: { ...config.display, ...overrides.display },
  });
  if (
    Object.keys(overrides).some((key) =>
      [
        "provider",
        "default_provider",
        "model",
        "endpoint",
        "thinking",
        "limits",
      ].includes(key),
    )
  ) {
    applySelection(config, overrides);
  }
  for (const field of Object.keys(overrides)) {
    sourceMap.set(field, { field, scope: "override" });
  }
  if (overrides.mcp_servers !== undefined) {
    projectServers = [];
  } else {
    projectServers = projectServers.filter(
      (server) => server.enabled !== false,
    );
  }
  validateMcpServers(config);
  return { config, sources: [...sourceMap.values()], projectServers };
}

function providerIdentity(provider: ProviderConfig): ProviderConfig {
  return {
    name: provider.name,
    protocol: provider.protocol,
    base_url: provider.base_url,
    model: provider.model,
    api_key: provider.api_key,
  };
}

function providerForTarget(
  provider: ProviderConfig,
  selection: Pick<Partial<ProviderConfig>, "base_url" | "model" | "protocol">,
): ProviderConfig {
  if (selection.base_url !== undefined) {
    let endpointChanged: boolean;
    try {
      endpointChanged =
        new URL(selection.base_url).href !== new URL(provider.base_url).href;
    } catch {
      throw new ConfigError(PROJECT_ERRORS.incompleteProvider);
    }
    if (endpointChanged) {
      return credentialFreeProvider(provider);
    }
  }
  if (
    (selection.model !== undefined && selection.model !== provider.model) ||
    (selection.protocol !== undefined &&
      selection.protocol !== provider.protocol)
  ) {
    return providerIdentity(provider);
  }
  return provider;
}

export function credentialFreeProvider(
  provider: ProviderConfig,
): ProviderConfig {
  // An explicit empty key also blocks the ambient environment fallback.
  return { ...providerIdentity(provider), api_key: "" };
}
