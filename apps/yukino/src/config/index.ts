import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  getParseErrorMessage,
  safeParse,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import yaml from "js-yaml";
import { z } from "zod";

import {
  globalConfigPath,
  ProviderConfigSchema,
  withProviderDefaults,
  type ProviderConfig,
} from "./provider-config.js";

import { createChildLogger } from "@/logger/index.js";
import { LspServerConfigSchema } from "@/lsp/config.js";

export * as ProviderConfig from "./provider-config.js";
export * as ProviderLogin from "./provider-login.js";

const log = createChildLogger({ module: "config" });

const ENV_KEY_MAP = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "openai-compat": "OPENAI_API_KEY",
};

function isKeyofTypeofEnvKeyMap(k: string): k is keyof typeof ENV_KEY_MAP {
  return VALID_PROTOCOLS.has(k);
}

const VALID_PROTOCOLS = new Set(Object.keys(ENV_KEY_MAP));

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
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

const AppConfigSchema = z.looseObject({
  default_provider: z.number().default(0),
  providers: z.array(ProviderConfigSchema),
  permission_mode: z.string().optional(),
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
   * Whether to fork when subagent_type is omitted. Enabled by default, so this
   * field is left as undefined to represent "not specified in config"; only an
   * explicit `false` disables forking (see forkEnabled).
   */
  enable_fork: z.boolean().optional(),
  /**
   * Whether auto memory is enabled: gates index injection, recall, and
   * background extraction in the hosts that run them (interactive UI, remote,
   * ACP), and consolidation, which currently runs only in remote mode.
   * Defaults to enabled; `enable_memory: false` turns the whole automatic
   * memory pipeline off. Left optional so "not set" and "explicitly false"
   * stay distinguishable, mirroring enable_fork.
   */
  enable_memory: z.boolean().optional(),
});

/** Whether fork is available. Defaults to enabled when not specified in config. */
export function forkEnabled(cfg: AppConfig): boolean {
  return cfg.enable_fork !== false;
}

/** Whether auto memory is enabled. Defaults to enabled when not specified in config. */
export function memoryEnabled(cfg: AppConfig): boolean {
  return cfg.enable_memory !== false;
}

export type AppConfig = z.infer<typeof AppConfigSchema>;

function loadSingleFile(path: string): AppConfig {
  const data = readFileSync(path, "utf-8");
  const raw: unknown = yaml.load(data);
  const parsed = safeParse(AppConfigSchema, raw);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid configuration in ${path}: ${getParseErrorMessage(parsed.error)}`,
    );
  }
  const config = parsed.data;
  return {
    ...config,
    providers: config.providers.map(withProviderDefaults),
  };
}

function validateProviders(config: AppConfig): void {
  if (config.providers.length === 0) {
    throw new ConfigError("At least one provider MUST be configured.");
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

/** Project-level MCP config file, compatible with the Claude Code format. */
const PROJECT_MCP_FILENAME = ".mcp.json";

const McpJsonEntrySchema = z.looseObject({
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
      return { default_provider: 0, providers: [], mcp_servers: [], hooks: [] };
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
