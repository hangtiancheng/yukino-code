import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  getParseErrorMessage,
  safeParse,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import yaml from "js-yaml";
import { z } from "zod";

import {
  ENV_KEY_MAP,
  INVALID_MCP_SETTINGS_ERROR,
  INVALID_PROJECT_CONFIG_ERROR,
  INVALID_PROJECT_YAML_ERROR,
  REMOVED_MCP_LOADING_ERROR,
  REMOVED_CODE_MODE_ERROR,
  NO_PROVIDERS_ERROR,
  THINKING_LEVELS,
  VALID_PROTOCOLS,
  YAML_PARSE_ERROR,
} from "@/config/constants.js";
import {
  PreferencesPatchSchema,
  RuntimePreferencesSchema,
  type PreferencesPatch,
} from "@/config/preferences.js";
import {
  globalConfigPath,
  ProviderConfigSchema,
  withProviderDefaults,
  type ProviderConfig,
} from "@/config/provider-config.js";
import { MCPServerConfigSchema } from "@/mcp/config.js";
import { readPrivateFileSync } from "@/storage/private.js";
import { asRecord } from "@/utils/index.js";

export * from "@/config/preferences.js";
export * from "@/config/constants.js";
export * from "@/config/provider-config.js";
export * from "@/config/provider-login.js";

function isKeyofTypeofEnvKeyMap(k: string): k is keyof typeof ENV_KEY_MAP {
  return VALID_PROTOCOLS.has(k);
}

export class ConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConfigError";
  }
}

export function resolveAPIKey(p: ProviderConfig): string {
  if (p.api_key !== undefined) {
    return p.api_key;
  }

  const envVar = isKeyofTypeofEnvKeyMap(p.protocol)
    ? ENV_KEY_MAP[p.protocol]
    : "";
  if (!envVar) {
    return "";
  }
  return process.env[envVar] ?? "";
}

export const ProjectMcpServerConfigSchema = MCPServerConfigSchema.superRefine(
  (server, ctx) => {
    for (const field of ["inherit_env", "cwd", "oauth", "dynamic"]) {
      if (Object.hasOwn(server, field)) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: INVALID_PROJECT_CONFIG_ERROR,
        });
      }
    }
  },
);

export const HookConfigSchema = z.object({
  id: z.string().optional(),
  event: z.string(),
  condition: z.string().optional(),
  action: z.object({
    type: z.string(),
    command: z.string().optional(),
    url: z.string().optional(),
    method: z.string().optional(),
    prompt: z.string().optional(),
  }),
  reject: z.boolean().optional(),
  once: z.boolean().optional(),
  async: z.boolean().optional(),
  on_error: z.string().optional(),
});

export type HookConfig = z.infer<typeof HookConfigSchema>;

const SandboxYamlConfigSchema = z.object({
  enabled: z.boolean().optional(),
  auto_allow: z.boolean().optional(),
  network_enabled: z.boolean().optional(), // TODO: rename to enable_network
});

export type SandboxYamlConfig = z.infer<typeof SandboxYamlConfigSchema>;

/**
 * One `env` block value. YAML scalars arrive as string/number/boolean and are
 * stringified for process.env; an empty value (`KEY:`) becomes "".
 */
const EnvValueSchema = z
  .union([z.string(), z.number(), z.boolean()])
  .nullish()
  .transform((value) => (value == null ? "" : String(value)));

/**
 * The `env` block accepts a plain mapping (`env: {KEY: value}`) or a list of
 * single-key mappings (`env:\n  - KEY: value`), normalized to one record. A
 * bare `env:` (null — every entry commented out) is treated as empty.
 */
const EnvBlockSchema = z
  .union([
    z.record(z.string(), EnvValueSchema),
    z.array(z.record(z.string(), EnvValueSchema)),
    z.null(),
  ])
  .transform((block) => {
    if (block === null) {
      return {};
    }
    if (!Array.isArray(block)) {
      return block;
    }
    const merged: Record<string, string> = {};
    for (const entry of block) {
      for (const [key, value] of Object.entries(entry)) {
        merged[key] = value;
      }
    }
    return merged;
  });

export const ResourceSettingsSchema = z.strictObject({
  paths: z.array(z.string().min(1)).optional(),
  disabled: z.array(z.string().min(1)).optional(),
});

export const ExtensionConfigSchema = z.strictObject({
  name: z.string().min(1),
  path: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

const LimitsSchema = z.strictObject({
  max_turns: z.number().int().positive().optional(),
  context_window: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
});

export const AppConfigSchema = z
  .looseObject({
    default_provider: z.number().default(0),
    providers: z.array(ProviderConfigSchema).default([]),
    permission_mode: z
      .enum(["default", "acceptEdits", "plan", "bypassPermissions"])
      .optional(),
    ...RuntimePreferencesSchema.shape,
    mcp_servers: z.array(MCPServerConfigSchema).default([]),
    hooks: z.array(HookConfigSchema).default([]),
    sandbox: SandboxYamlConfigSchema.optional(),
    enable_coordinator_mode: z.boolean().optional(),
    shellPath: z.string().min(1).optional(),
    shellCommandPrefix: z.string().optional(),
    /**
     * Whether auto memory is enabled: gates index injection, recall, background
     * extraction, and consolidation in interactive and remote agent hosts.
     * Defaults to enabled; `enable_memory: false` turns the whole automatic
     * memory pipeline off. Left optional so "not set" and "explicitly false"
     * stay distinguishable.
     */
    enable_memory: z.boolean().optional(),
    /**
     * Environment defaults for telemetry and Yukino integrations, applied only
     * to unset variables. Product settings use their typed config fields.
     */
    env: EnvBlockSchema.optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    endpoint: z.string().optional(),
    thinking: z.enum(THINKING_LEVELS).optional(),
    limits: LimitsSchema.optional(),
    prompts: ResourceSettingsSchema.optional(),
    skills: ResourceSettingsSchema.optional(),
    workflow: ResourceSettingsSchema.optional(),
    extensions: z.array(ExtensionConfigSchema).optional(),
  })
  .superRefine((config, ctx) => {
    if (Object.hasOwn(config, "mcp_loading")) {
      ctx.addIssue({
        code: "custom",
        path: ["mcp_loading"],
        message: REMOVED_MCP_LOADING_ERROR,
      });
    }
    if (Object.hasOwn(config, "enable_code_mode")) {
      ctx.addIssue({
        code: "custom",
        path: ["enable_code_mode"],
        message: REMOVED_CODE_MODE_ERROR,
      });
    }
  });

const ProjectProviderSchema = z.strictObject({
  name: z.string().min(1),
  protocol: ProviderConfigSchema.shape.protocol.optional(),
  base_url: z.url().optional(),
  model: z.string().min(1).optional(),
  thinking: z.enum(THINKING_LEVELS).optional(),
  sampling_params: ProviderConfigSchema.shape.sampling_params,
  sampling_params_by_thinking_level:
    ProviderConfigSchema.shape.sampling_params_by_thinking_level,
  context_window: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
});

const ProjectHookSchema = HookConfigSchema.extend({
  id: z.string().min(1),
  enabled: z.boolean().optional(),
  event: z.string().optional(),
  action: HookConfigSchema.shape.action.strict().optional(),
})
  .strict()
  .refine(
    (hook) => hook.enabled === false || Boolean(hook.event && hook.action),
  );

export const ProjectConfigSchema = z.strictObject({
  default_provider: z.number().int().nonnegative().optional(),
  provider: z.string().min(1).optional(),
  providers: z.array(ProjectProviderSchema).optional(),
  model: z.string().min(1).optional(),
  endpoint: z.url().optional(),
  thinking: z.enum(THINKING_LEVELS).optional(),
  limits: LimitsSchema.optional(),
  ...PreferencesPatchSchema.shape,
  enable_coordinator_mode: z.boolean().optional(),
  shellPath: z.string().min(1).optional(),
  shellCommandPrefix: z.string().optional(),
  enable_memory: z.boolean().optional(),
  prompts: ResourceSettingsSchema.optional(),
  skills: ResourceSettingsSchema.optional(),
  workflow: ResourceSettingsSchema.optional(),
  hooks: z.array(ProjectHookSchema).optional(),
  mcp_servers: z.array(ProjectMcpServerConfigSchema).optional(),
  extensions: z.array(ExtensionConfigSchema).optional(),
  /** Only passed to controlled project subprocesses, never to process.env. */
  env: EnvBlockSchema.optional(),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export function parseProjectConfig(data: string, path: string): ProjectConfig {
  let raw: unknown;
  try {
    raw = yaml.load(data);
  } catch {
    throw new ConfigError(`${INVALID_PROJECT_YAML_ERROR} in ${path}`);
  }
  const parsed = ProjectConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => issue.path.join("."))
      .filter(Boolean);
    throw new ConfigError(
      `${INVALID_PROJECT_CONFIG_ERROR} in ${path}${fields.length ? ` (${fields.join(", ")})` : ""}`,
    );
  }
  return parsed.data;
}

/** Whether auto memory is enabled. Defaults to enabled when not specified in config. */
export function memoryEnabled(cfg: AppConfig): boolean {
  return cfg.enable_memory !== false;
}

/**
 * Applies the config's `env` block to process.env, filling only variables
 * that are unset in the real environment — explicit environment always wins.
 * Idempotent: repeated config loads never clobber anything.
 */
export function applyConfigEnv(env: Record<string, string> | undefined): void {
  if (!env) {
    return;
  }
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * Early-startup hydration: fills process.env from the global config's `env`
 * block before anything reads it — telemetry initializes before the mode
 * runners load the config. Tolerant by design: a missing or broken config is
 * reported by the real loadConfig call later; hydration must never block
 * startup.
 */
export function hydrateConfigEnv(): void {
  try {
    const path = globalConfigPath();
    if (existsSync(path)) {
      applyConfigEnv(loadSingleFile(path).env);
    }
  } catch {
    // The real load at startup reports config errors.
  }
}

export type AppConfig = z.infer<typeof AppConfigSchema>;
type AppConfigFields = {
  [K in keyof AppConfig as string extends K ? never : K]: AppConfig[K];
};
export type AppConfigOverrides = Omit<
  Partial<AppConfigFields>,
  "code_mode" | "display"
> &
  PreferencesPatch;
const configSourcePaths = new WeakMap<object, string>();
const configExplicitFields = new WeakMap<object, string[]>();

export function getConfigExplicitFields(
  config: AppConfig,
): string[] | undefined {
  const fields = configExplicitFields.get(config);
  return fields && [...fields];
}

export function getConfigSourcePath(config: AppConfig): string | undefined {
  return configSourcePaths.get(config);
}

export function cloneAppConfig(config: AppConfig): AppConfig {
  return inheritConfigMetadata(config, structuredClone(config));
}

export function inheritConfigMetadata(
  config: object,
  copy: AppConfig,
): AppConfig {
  const path = configSourcePaths.get(config);
  if (path) {
    configSourcePaths.set(copy, path);
  }
  const fields =
    configExplicitFields.get(config) ??
    Object.keys(config).filter((key) => Reflect.get(config, key) !== undefined);
  configExplicitFields.set(copy, [...fields]);
  return copy;
}

// Reports a js-yaml failure as reason + line/column only. The exception's
// full message embeds a source snippet, which could contain secrets, so it is
// deliberately not surfaced.
function yamlErrorDetail(err: unknown): string {
  if (!err || typeof err !== "object") {
    return YAML_PARSE_ERROR;
  }
  const e = asRecord(err);
  const reason =
    typeof e.reason === "string" && e.reason.length > 0
      ? e.reason
      : YAML_PARSE_ERROR;
  const mark = asRecord(e.mark);
  if (typeof mark.line === "number") {
    const line = String(mark.line + 1);
    const column =
      typeof mark.column === "number"
        ? `, column ${String(mark.column + 1)}`
        : "";
    return `${reason} (line ${line}${column})`;
  }
  return reason;
}

function loadSingleFile(path: string): AppConfig {
  const data = readPrivateFileSync(path, "utf-8");
  let raw: unknown;
  try {
    raw = yaml.load(data);
  } catch (err) {
    throw new ConfigError(`Invalid YAML in ${path}: ${yamlErrorDetail(err)}`, {
      cause: err,
    });
  }
  const parsed = safeParse(AppConfigSchema, raw);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid configuration in ${path}: ${getParseErrorMessage(parsed.error)}`,
    );
  }
  const config = parsed.data;
  const base = dirname(resolve(path));
  const result = {
    ...config,
    providers: config.providers.map(withProviderDefaults),
    prompts: config.prompts && {
      ...config.prompts,
      paths: config.prompts.paths?.map((entry) => resolve(base, entry)),
    },
    skills: config.skills && {
      ...config.skills,
      paths: config.skills.paths?.map((entry) => resolve(base, entry)),
    },
    workflow: config.workflow && {
      ...config.workflow,
      paths: config.workflow.paths?.map((entry) => resolve(base, entry)),
    },
    extensions: config.extensions?.map((extension) => ({
      ...extension,
      path: extension.path && resolve(base, extension.path),
    })),
  };
  configSourcePaths.set(result, resolve(path));
  configExplicitFields.set(result, Object.keys(asRecord(raw)));
  return result;
}

function validateProviders(config: AppConfig): void {
  if (config.providers.length === 0) {
    throw new ConfigError(NO_PROVIDERS_ERROR);
  }

  const requiredFields = ["name", "protocol", "base_url", "model"] as const;
  const baseUrls = new Map<string, number>();
  for (let i = 0; i < config.providers.length; i++) {
    const p = config.providers[i];
    const values = {
      name: p.name,
      protocol: p.protocol,
      base_url: p.base_url,
      model: p.model,
    } as const;
    const missing = requiredFields.filter((field) => !values[field].trim());
    if (missing.length > 0) {
      throw new ConfigError(
        `Provider #${String(i + 1)}: missing fields: ${missing.join(", ")}`,
      );
    }

    const previous = baseUrls.get(p.base_url);
    if (previous !== undefined) {
      throw new ConfigError(
        `Provider #${String(i + 1)}: duplicate base_url '${p.base_url}' (already used by provider #${String(previous + 1)}).`,
      );
    }
    baseUrls.set(p.base_url, i);
  }
}

export function validateMcpServers(
  config: Pick<AppConfig, "mcp_servers">,
): void {
  const names = new Map<string, number>();
  for (let i = 0; i < config.mcp_servers.length; i++) {
    const server = config.mcp_servers[i];
    const position = `MCP server #${String(i + 1)}`;
    if (!server.name.trim()) {
      throw new ConfigError(`${position}: name must not be empty.`);
    }
    const previous = names.get(server.name);
    if (previous !== undefined) {
      throw new ConfigError(
        `${position}: duplicate name '${server.name}' (already used by MCP server #${String(previous + 1)}).`,
      );
    }
    names.set(server.name, i);
    if (server.enabled === false) {
      continue;
    }

    const hasCommand = Boolean(server.command?.trim());
    const hasUrl = Boolean(server.url?.trim());
    if (hasCommand === hasUrl) {
      throw new ConfigError(
        `${position} '${server.name}': configure exactly one of command or url.`,
      );
    }
    if (hasCommand && server.transport && server.transport !== "stdio") {
      throw new ConfigError(
        `${position} '${server.name}': command servers must use stdio.`,
      );
    }
    if (hasUrl && server.transport === "stdio") {
      throw new ConfigError(
        `${position} '${server.name}': URL transport must be http.`,
      );
    }
    if (!MCPServerConfigSchema.safeParse(server).success) {
      throw new ConfigError(`${position}: ${INVALID_MCP_SETTINGS_ERROR}.`);
    }
  }
}

export function loadConfig(
  path?: string,
  options: { allowEmptyProviders?: boolean } = {},
): AppConfig {
  if (path) {
    const config = loadSingleFile(path);
    validateMcpServers(config);
    if (!options.allowEmptyProviders || config.providers.length > 0) {
      validateProviders(config);
    }
    return config;
  }

  const candidate = globalConfigPath();

  if (!existsSync(candidate)) {
    if (options.allowEmptyProviders) {
      return AppConfigSchema.parse({ providers: [] });
    }
    throw new ConfigError(`No config file found, expected ${candidate}.`);
  }

  const config = loadSingleFile(candidate);
  validateMcpServers(config);
  if (!options.allowEmptyProviders || config.providers.length > 0) {
    validateProviders(config);
  }
  return config;
}

export * from "@/config/provider-input.js";
