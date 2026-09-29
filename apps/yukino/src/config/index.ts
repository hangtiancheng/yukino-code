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

const log = createChildLogger({ module: "config" });

const ENV_KEY_MAP = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "openai-compat": "OPENAI_API_KEY",
};

function isKeyofTypeofEnvKeyMap(k: string): k is keyof typeof ENV_KEY_MAP {
  return VALID_PROTOCOLS.has(k);
}

/** enum: "anthropic", "openai", "openai-compat" */
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
  backend: z.enum(["native", "sandbox-runtime"]).optional(),
  auto_allow: z.boolean().optional(),
  network_enabled: z.boolean().optional(),
});

export type SandboxYamlConfig = z.infer<typeof SandboxYamlConfigSchema>;

const AppConfigSchema = z.looseObject({
  default_provider: z.number().default(0),
  providers: z.array(ProviderConfigSchema),
  permission_mode: z.string().optional(),
  mcp_servers: z.array(MCPServerConfigSchema).default([]),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function loadSingleFile(path: string): AppConfig {
  const data = readFileSync(path, "utf-8");
  const raw: unknown = yaml.load(data);
  if (!isRecord(raw)) {
    log.error({ path }, "invalid yaml");
    return { default_provider: 0, providers: [], mcp_servers: [], hooks: [] };
  }
  const parsed = safeParse(AppConfigSchema, raw);
  if (parsed.success) {
    const data = parsed.data;
    return {
      ...data,
      providers: data.providers.map(withProviderDefaults),
    };
  }
  log.error({ error: parsed.error }, "config error");
  let defaultProvider = 0;
  let providers: ProviderConfig[] = [];
  let permissionMode: string | undefined;
  let mcpServers: MCPServerConfig[] = [];
  let hooks: HookConfig[] = [];
  let sandbox: SandboxYamlConfig | undefined = undefined;
  let enableCoordinatorMode = false;
  let enableFork = true;
  let enableMemory = true;

  if ("default_provider" in raw) {
    const parsed = safeParse(z.number(), raw.default_provider);
    if (parsed.success) {
      defaultProvider = parsed.data;
    }
  }
  if ("providers" in raw) {
    const parsed = safeParse(z.array(ProviderConfigSchema), raw.providers);
    if (parsed.success) {
      providers = parsed.data.map(withProviderDefaults);
    } else {
      // Providers are required for the app to function; surface schema errors
      // (e.g. a removed legacy field) instead of silently dropping them.
      throw new ConfigError(
        `Invalid provider configuration in ${path}: ${getParseErrorMessage(parsed.error)}`,
      );
    }
  }
  if ("permission_mode" in raw && typeof raw.permission_mode === "string") {
    permissionMode = raw.permission_mode;
  }
  if ("mcp_servers" in raw) {
    const parsed = safeParse(z.array(MCPServerConfigSchema), raw.mcp_servers);
    if (parsed.success) {
      mcpServers = parsed.data;
    } else {
      throw new ConfigError(
        `Invalid MCP server configuration in ${path}: ${getParseErrorMessage(parsed.error)}`,
      );
    }
  }
  if ("hooks" in raw) {
    const parsed = safeParse(z.array(HookConfigSchema), raw.hooks);
    if (parsed.success) {
      hooks = parsed.data;
    } else {
      // Match providers/mcp_servers: a malformed hooks entry is a config
      // error to surface, not something to silently drop to [].
      throw new ConfigError(
        `Invalid hooks configuration in ${path}: ${getParseErrorMessage(parsed.error)}`,
      );
    }
  }
  if ("sandbox" in raw) {
    const parsed = safeParse(SandboxYamlConfigSchema, raw.sandbox);
    if (parsed.success) {
      sandbox = parsed.data;
    } else {
      throw new ConfigError(
        `Invalid sandbox configuration in ${path}: ${getParseErrorMessage(parsed.error)}`,
      );
    }
  }
  if ("enable_coordinator_mode" in raw) {
    enableCoordinatorMode = Boolean(raw.enable_coordinator_mode);
  }
  if ("enable_fork" in raw) {
    enableFork = Boolean(raw.enable_fork);
  }
  if ("enable_memory" in raw) {
    enableMemory = Boolean(raw.enable_memory);
  }
  return {
    default_provider: defaultProvider,
    providers,
    permission_mode: permissionMode,
    mcp_servers: mcpServers,
    hooks,
    sandbox,
    enable_coordinator_mode: enableCoordinatorMode,
    enable_fork: enableFork,
    enable_memory: enableMemory,
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
 * Reads project-level MCP servers from `<workDir>/.mcp.json`. A missing file
 * yields [] silently and a malformed one yields [] with a log entry, so a
 * broken repo-side config does not prevent startup, and an entry that cannot
 * be mapped is skipped so one bad server does not hide its siblings.
 */
export function loadProjectMcpServers(workDir: string): MCPServerConfig[] {
  const path = join(workDir, PROJECT_MCP_FILENAME);
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
 * Returns a copy of `config` with the servers from `<workDir>/.mcp.json`
 * appended. User-level (config.yaml) entries win on a name collision: the
 * project file ships with the repository and is less trusted than the user's
 * own config.
 */
export function withProjectMcpServers(
  config: AppConfig,
  workDir: string,
): AppConfig {
  const projectServers = loadProjectMcpServers(workDir);
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

export * as ProviderConfig from "./provider-config.js";
export * as ProviderLogin from "./provider-login.js";
