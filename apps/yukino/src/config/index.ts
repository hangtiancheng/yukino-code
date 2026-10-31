import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  getParseErrorMessage,
  safeParse,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import yaml from "js-yaml";
import { z } from "zod";

import {
  ENV_KEY_MAP,
  MCP_LOADING_MODES,
  NO_PROVIDERS_ERROR,
  PROJECT_MCP_FILENAME,
  THEME_MODES,
  VALID_PROTOCOLS,
  YAML_PARSE_ERROR,
} from "@/config/constants.js";
import {
  globalConfigPath,
  ProviderConfigSchema,
  withProviderDefaults,
  type ProviderConfig,
} from "@/config/provider-config.js";
import { createChildLogger } from "@/logger/index.js";
import { LspServerConfigSchema } from "@/lsp/config.js";
import { readPrivateFileSync } from "@/storage/private.js";
import { asRecord } from "@/utils/index.js";

export * as Constants from "@/config/constants.js";
export * as ProviderConfig from "@/config/provider-config.js";
export * as ProviderLogin from "@/config/provider-login.js";

const log = createChildLogger({ module: "config" });

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
  if (p.api_key) {
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

const MCPServerConfigSchema = z.object({
  name: z.string(),
  enabled: z.boolean().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  transport: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;

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
  network_enabled: z.boolean().optional(),
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

const AppConfigSchema = z.looseObject({
  default_provider: z.number().default(0),
  providers: z.array(ProviderConfigSchema),
  permission_mode: z
    .enum(["default", "acceptEdits", "plan", "bypassPermissions"])
    .optional(),
  mcp_loading: z.enum(MCP_LOADING_MODES).default("auto"),
  theme: z.enum(THEME_MODES).default("auto"),
  mcp_servers: z.array(MCPServerConfigSchema).default([]),
  lsp_servers: z
    .array(LspServerConfigSchema)
    .refine(
      (servers) =>
        new Set(servers.map((server) => server.name)).size === servers.length,
      "LSP server names must be unique",
    )
    .optional(),
  hooks: z.array(HookConfigSchema).default([]),
  sandbox: SandboxYamlConfigSchema.optional(),
  enable_coordinator_mode: z.boolean().optional(),
  /**
   * Default for the Agent tool's independent fork parameter. Defaults to true;
   * an explicit fork argument overrides this setting for any agent role.
   */
  enable_fork: z.boolean().optional(),
  /**
   * Whether auto memory is enabled: gates index injection, recall, and
   * background extraction in the hosts that run them (interactive UI and
   * remote), and consolidation, which currently runs only in remote mode.
   * Defaults to enabled; `enable_memory: false` turns the whole automatic
   * memory pipeline off. Left optional so "not set" and "explicitly false"
   * stay distinguishable, mirroring enable_fork.
   */
  enable_memory: z.boolean().optional(),
  /**
   * Environment defaults for telemetry and Yukino integrations, applied only
   * to unset variables. Product settings use their typed config fields.
   */
  env: EnvBlockSchema.optional(),
});

/** Default context inheritance for Agent calls. Defaults to true when unset. */
export function forkEnabled(cfg: AppConfig): boolean {
  return cfg.enable_fork !== false;
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
    loadConfig(undefined, { allowEmptyProviders: true });
  } catch {
    // The real load at startup reports config errors.
  }
}

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type McpLoading = AppConfig["mcp_loading"];

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
  // Hydrate before loadConfig's validation below, so the defaults apply even
  // when the real load later reports a provider/MCP validation error.
  applyConfigEnv(config.env);
  return {
    ...config,
    providers: config.providers.map(withProviderDefaults),
  };
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

    if (!VALID_PROTOCOLS.has(p.protocol)) {
      throw new ConfigError(
        `Provider #${String(i + 1)}: invalid protocol '${p.protocol}', MUST be one of: ${Array.from(VALID_PROTOCOLS).join(", ")}`,
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

function validateMcpServers(config: AppConfig): void {
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
    if (
      hasUrl &&
      server.transport &&
      !["http", "sse"].includes(server.transport)
    ) {
      throw new ConfigError(
        `${position} '${server.name}': URL transport must be http or sse.`,
      );
    }
  }
}

const McpJsonEntrySchema = z.looseObject({
  enabled: z.boolean().default(true),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  type: z.enum(["stdio", "sse", "http"]).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

type McpJsonEntry = z.infer<typeof McpJsonEntrySchema>;

const McpJsonFileSchema = z.looseObject({
  // Parse entries independently below so one bad server does not disable every
  // valid server in the project file.
  mcpServers: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Maps one `.mcp.json` entry onto an MCPServerConfig. An explicit `type` wins;
 * otherwise stdio is inferred from `command` and http from `url`. Entries that
 * lack the field their transport needs are rejected (returns null).
 */
function mcpServerFromJsonEntry(
  name: string,
  entry: McpJsonEntry,
): MCPServerConfig | null {
  const transport =
    entry.type ?? (entry.command !== undefined ? "stdio" : "http");
  if (transport === "stdio") {
    if (!entry.command || entry.url !== undefined) {
      return null;
    }
    return { name, command: entry.command, args: entry.args, env: entry.env };
  }
  if (!entry.url || entry.command !== undefined) {
    return null;
  }
  return { name, url: entry.url, transport, headers: entry.headers };
}

/**
 * Reads project-level MCP servers from `<cwd>/.mcp.json`. A missing file
 * yields [] silently and a malformed one yields [] with a log entry, so a
 * broken repo-side config does not prevent startup, and an entry that cannot
 * be mapped is skipped so one bad server does not hide its siblings.
 */
export function loadProjectMcpServers(cwd: string): MCPServerConfig[] {
  const path = join(cwd, PROJECT_MCP_FILENAME);
  if (!existsSync(path)) {
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    log.error({ err, path }, "invalid .mcp.json");
    return [];
  }
  const parsed = safeParse(McpJsonFileSchema, raw);
  if (!parsed.success) {
    log.error({ error: parsed.error, path }, "invalid .mcp.json");
    return [];
  }
  const servers: MCPServerConfig[] = [];
  for (const [name, rawEntry] of Object.entries(parsed.data.mcpServers)) {
    const parsedEntry = safeParse(McpJsonEntrySchema, rawEntry);
    if (!name.trim() || !parsedEntry.success) {
      log.warn(
        {
          name,
          path,
          error: parsedEntry.success ? undefined : parsedEntry.error,
        },
        "skipping invalid .mcp.json server entry",
      );
      continue;
    }
    if (!parsedEntry.data.enabled) {
      continue;
    }
    const server = mcpServerFromJsonEntry(name, parsedEntry.data);
    if (server) {
      servers.push(server);
    } else {
      log.warn({ name, path }, "skipping invalid .mcp.json server entry");
    }
  }
  return servers;
}

/**
 * Returns a copy of `config` with the servers from `<cwd>/.mcp.json`
 * appended. User-level (config.yaml) entries win on a name collision: the
 * project file ships with the repository and is less trusted than the user's
 * own config.
 */
export function withProjectMcpServers(
  config: AppConfig,
  cwd: string,
): AppConfig {
  const projectServers = loadProjectMcpServers(cwd);
  if (projectServers.length === 0) {
    return config;
  }
  const known = new Set(config.mcp_servers.map((s) => s.name));
  return {
    ...config,
    mcp_servers: [
      ...config.mcp_servers,
      ...projectServers.filter((s) => !known.has(s.name)),
    ],
  };
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
