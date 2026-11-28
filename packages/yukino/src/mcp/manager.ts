import { randomUUID } from "node:crypto";

import { MCPClient, expandMcpServerConfigEnvironment } from "@/mcp/client.js";
import type {
  MCPClientOptions,
  MCPRequestOptions,
  MCPTool,
} from "@/mcp/client.js";
import { MCPServerConfigSchema } from "@/mcp/config.js";
import type { MCPExposure, MCPServerConfig } from "@/mcp/config.js";
import { MCP_RESOURCE_READ_TOOL } from "@/mcp/constants.js";
import {
  MCPConnectionError,
  isOptionalMCPConnectionError,
  mcpConnectionError,
} from "@/mcp/errors.js";
import type { MCPConnectionDiagnostic } from "@/mcp/errors.js";
import { MCPOAuthProvider } from "@/mcp/oauth.js";
import type { MCPLoginOptions, MCPOAuthOptions } from "@/mcp/oauth.js";
import { resolveMCPExposure } from "@/mcp/policy.js";
import type { ToolInvocationEntry } from "@/mcp/policy.js";
import {
  buildMcpToolName,
  MCPToolWrapper,
  sanitizeSegment,
} from "@/mcp/tool-wrapper.js";
import type { ToolRegistry } from "@/tools/registry.js";

export interface ConnectResult {
  tools: { serverName: string; tool: MCPTool }[];
  servers: string[];
  errors: {
    serverName: string;
    error: string;
    diagnostic: MCPConnectionDiagnostic;
  }[];
  instructions: { serverName: string; text: string }[];
}
export type MCPSourceScope = "global" | "project" | "extension" | "runtime";
export interface MCPSource {
  readonly id: string;
  readonly owner: string;
  readonly scope: MCPSourceScope;
  readonly projectRoot?: string;
}
export interface MCPServerState {
  name: string;
  source: MCPSource;
  state: "registered" | "connected" | "error";
  exposure: MCPExposure;
  tools: number;
  unreachableCodeMode: boolean;
  diagnostic?: MCPConnectionDiagnostic;
}
export interface MCPManagerOptions {
  appsEnabled?: boolean;
  registry?: ToolRegistry;
  authorizeProject?: (
    source: MCPSource,
    config: MCPServerConfig,
  ) => boolean | Promise<boolean>;
  clientOptions?: MCPClientOptions;
  oauth?: MCPOAuthOptions;
  clientFactory?: (
    config: MCPServerConfig,
    appsEnabled: boolean,
    options: MCPClientOptions,
  ) => MCPClient;
}
interface ServerRecord {
  config: MCPServerConfig;
  source: MCPSource;
  client?: MCPClient;
  oauth?: MCPOAuthProvider;
  tools: MCPTool[];
  state: MCPServerState["state"];
  unsubscribe?: () => void;
  failure?: MCPConnectionError;
}

export class MCPManager {
  private records = new Map<string, ServerRecord>();
  private sources = new WeakSet<MCPSource>();
  private revokedSources = new WeakSet<MCPSource>();
  private runtimeAuthorizers = new WeakMap<MCPSource, () => boolean>();
  private operation = Promise.resolve();
  private revision = 0;
  private listeners = new Set<() => void>();
  private options: MCPManagerOptions;
  private globalSource: MCPSource;
  constructor(options: MCPManagerOptions = {}) {
    this.options = options;
    this.globalSource = this.createSource("global", "user-config");
  }
  get generation(): number {
    return this.revision;
  }
  get cacheVersion(): number {
    return this.revision;
  }
  createSource(
    scope: MCPSourceScope,
    owner: string,
    projectRoot?: string,
  ): MCPSource {
    const source = Object.freeze({
      id: randomUUID(),
      scope,
      owner,
      ...(projectRoot ? { projectRoot } : {}),
    });
    this.sources.add(source);
    return source;
  }
  createRuntimeSource(owner: string, authorize: () => boolean): MCPSource {
    const source = this.createSource("runtime", owner);
    this.runtimeAuthorizers.set(source, authorize);
    return source;
  }
  getServerConfig(name: string): MCPServerConfig {
    return structuredClone(this.record(name).config);
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(): void {
    this.revision++;
    const registry = this.options.registry;
    if (registry) {
      const deferred = registry
        .listTools()
        .some((tool) => registry.exposure(tool.name) === "deferred");
      registry.exposeToolSearch = deferred;
      registry.exposeMcpCall = deferred && registry.mcpLoadingMode !== "native";
      registry.invalidate();
    }
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Observers cannot veto lifecycle commits. */
      }
    }
  }
  bindRegistry(registry: ToolRegistry): void {
    if (this.options.registry && this.options.registry !== registry) {
      throw new Error("MCP manager already belongs to another registry");
    }
    const wrappers = [...this.records.values()].flatMap((record) =>
      record.client ? this.wrappers(record, record.client, record.tools) : [],
    );
    registry.replaceTools([], wrappers);
    this.options.registry = registry;
    this.changed();
  }
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.operation.then(fn, fn);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private assertSource(source: MCPSource): void {
    if (!this.sources.has(source)) {
      throw new Error(
        "MCP source must be generated by its host manager, not RPC metadata",
      );
    }
  }
  private async authorize(record: ServerRecord): Promise<void> {
    if (this.revokedSources.has(record.source)) {
      throw new Error("MCP source authorization revoked");
    }
    const runtimeAuthorization = this.runtimeAuthorizers.get(record.source);
    if (
      record.source.scope !== "global" &&
      !(runtimeAuthorization
        ? runtimeAuthorization()
        : await this.options.authorizeProject?.(
            record.source,
            structuredClone(record.config),
          ))
    ) {
      throw new Error("MCP source authorization required");
    }
    if (this.revokedSources.has(record.source)) {
      throw new Error("MCP source authorization revoked");
    }
  }
  private registerNow(
    config: MCPServerConfig,
    source: MCPSource,
  ): ServerRecord {
    this.assertSource(source);
    const parsed = MCPServerConfigSchema.parse(config);
    if (
      this.records.has(parsed.name) ||
      [...this.records.keys()].some(
        (name) => sanitizeSegment(name) === sanitizeSegment(parsed.name),
      )
    ) {
      throw new Error("MCP server name/source collision");
    }
    const record: ServerRecord = {
      config: parsed,
      source,
      tools: [],
      state: "registered",
    };
    this.records.set(parsed.name, record);
    this.changed();
    return record;
  }
  async registerServer(
    config: MCPServerConfig,
    source: MCPSource,
    validate?: () => void,
  ): Promise<MCPServerState> {
    const snapshot = MCPServerConfigSchema.parse(config);
    return this.runExclusive(async () => {
      this.assertSource(source);
      await this.authorize({
        config: snapshot,
        source,
        tools: [],
        state: "registered",
      });
      validate?.();
      this.registerNow(snapshot, source);
      return this.requiredState(snapshot.name);
    });
  }
  async registerAndConnect(
    config: MCPServerConfig,
    source: MCPSource,
    validate?: () => void,
  ): Promise<MCPServerState> {
    const snapshot = MCPServerConfigSchema.parse(config);
    return this.runExclusive(async () => {
      this.assertSource(source);
      if (
        this.records.has(snapshot.name) ||
        [...this.records.keys()].some(
          (name) => sanitizeSegment(name) === sanitizeSegment(snapshot.name),
        )
      ) {
        throw new Error("MCP server name/source collision");
      }
      const record: ServerRecord = {
        config: snapshot,
        source,
        tools: [],
        state: "registered",
      };
      const candidate = await this.candidate(record, validate);
      await this.commit(record, candidate);
      return this.requiredState(snapshot.name);
    });
  }
  private record(name: string): ServerRecord {
    const record = this.records.get(name);
    if (!record) {
      throw new Error("Unknown MCP server");
    }
    return record;
  }
  state(name: string): MCPServerState | undefined {
    const record = this.records.get(name);
    if (!record) {
      return undefined;
    }
    return {
      name,
      source: record.source,
      state: record.state,
      exposure: record.config.exposure ?? "deferred",
      tools: record.tools.length,
      ...(record.failure ? { diagnostic: record.failure.diagnostic } : {}),
      unreachableCodeMode:
        (record.config.exposure === "codemode" ||
          record.config.tool_exposure?.some(
            (rule) => rule.exposure === "codemode",
          ) === true) &&
        this.options.registry?.getPolicy().codeModeEnabled !== true,
    };
  }
  private requiredState(name: string): MCPServerState {
    const state = this.state(name);
    if (!state) {
      throw new Error("Unknown MCP server");
    }
    return state;
  }
  states(): MCPServerState[] {
    return [...this.records.keys()].map((name) => this.requiredState(name));
  }
  sourcesForServers(): { name: string; source: MCPSource }[] {
    return this.states().map(({ name, source }) => ({ name, source }));
  }
  private wrappers(
    record: ServerRecord,
    client: MCPClient,
    tools: MCPTool[],
  ): MCPToolWrapper[] {
    const result = tools.map(
      (tool) =>
        new MCPToolWrapper(
          client,
          record.config.name,
          tool,
          resolveMCPExposure(record.config, tool.name),
          () => {
            const current = this.records.get(record.config.name);
            return (
              current?.client === client &&
              current.state === "connected" &&
              !this.revokedSources.has(current.source)
            );
          },
        ),
    );
    if (new Set(result.map((tool) => tool.name)).size !== result.length) {
      throw new Error("MCP sanitized tool name collision");
    }
    return result;
  }
  private attachGuard(record: ServerRecord, client: MCPClient): void {
    client.setInvocationGuard(
      (name, entry) =>
        this.records.get(record.config.name)?.client === client &&
        (entry === "resource"
          ? this.canReadResources(record.config.name, name)
          : this.canInvoke(record.config.name, name, entry)),
    );
  }
  private async candidate(
    record: ServerRecord,
    validate?: () => void,
    options: MCPRequestOptions = {},
  ): Promise<{ client: MCPClient; tools: MCPTool[] }> {
    options.signal?.throwIfAborted();
    await this.authorize(record);
    options.signal?.throwIfAborted();
    validate?.();
    if (record.config.enabled === false) {
      throw new Error("MCP server is disabled");
    }
    const config = expandMcpServerConfigEnvironment(
      record.config,
      record.config.inherit_env === false
        ? {}
        : (this.options.clientOptions?.environment ?? process.env),
    );
    if (config.oauth && !record.oauth) {
      if (!this.options.oauth) {
        throw new Error("Host OAuth token storage is required");
      }
      if (!config.url) {
        throw new Error("OAuth requires an HTTP endpoint");
      }
      record.oauth = new MCPOAuthProvider(
        config.url,
        config.oauth,
        this.options.oauth,
      );
    }
    const client = (
      this.options.clientFactory ??
      ((cfg, apps, options) => new MCPClient(cfg, apps, options))
    )(record.config, this.options.appsEnabled ?? false, {
      ...this.options.clientOptions,
      oauth: record.oauth,
    });
    try {
      validate?.();
      try {
        await client.connect(options);
      } catch (error) {
        throw mcpConnectionError(
          record.config,
          "connect",
          error,
          options.signal,
        );
      }
      options.signal?.throwIfAborted();
      let tools: MCPTool[];
      try {
        tools = await client.listTools(options);
      } catch (error) {
        throw mcpConnectionError(
          record.config,
          "discovery",
          error,
          options.signal,
        );
      }
      options.signal?.throwIfAborted();
      validate?.();
      if (this.revokedSources.has(record.source)) {
        throw new Error("MCP source authorization revoked");
      }
      try {
        this.wrappers(record, client, tools);
      } catch (error) {
        throw new MCPConnectionError(record.config, "publication", error);
      }
      return { client, tools };
    } catch (error) {
      await client.disconnect().catch(() => undefined);
      throw error;
    }
  }
  private async commit(
    record: ServerRecord,
    candidate: { client: MCPClient; tools: MCPTool[] },
  ): Promise<void> {
    const old = record.client;
    try {
      this.options.registry?.replaceTools(
        record.tools.map((tool) =>
          buildMcpToolName(record.config.name, tool.name),
        ),
        this.wrappers(record, candidate.client, candidate.tools),
      );
    } catch (error) {
      const failure = new MCPConnectionError(
        record.config,
        "publication",
        error,
      );
      await candidate.client.disconnect().catch(() => undefined);
      throw failure;
    }
    record.unsubscribe?.();
    record.client = candidate.client;
    record.tools = candidate.tools;
    record.state = "connected";
    record.failure = undefined;
    this.attachGuard(record, candidate.client);
    record.unsubscribe = candidate.client.onListChanged((kind) => {
      void this.runExclusive(async () => {
        if (record.client !== candidate.client) {
          return;
        }
        if (kind === "tools") {
          try {
            const tools = await candidate.client.listTools();
            this.options.registry?.replaceTools(
              record.tools.map((tool) =>
                buildMcpToolName(record.config.name, tool.name),
              ),
              this.wrappers(record, candidate.client, tools),
            );
            record.tools = tools;
          } catch {
            this.options.registry?.replaceTools(
              record.tools.map((tool) =>
                buildMcpToolName(record.config.name, tool.name),
              ),
              [],
            );
            record.tools = [];
            record.state = "error";
          }
        }
        this.changed();
      }).catch(() => undefined);
    });
    this.records.set(record.config.name, record);
    this.changed();
    await old?.disconnect().catch(() => undefined);
  }
  private failed(record: ServerRecord, error: unknown): void {
    record.state = "error";
    record.failure = error instanceof MCPConnectionError ? error : undefined;
    this.changed();
  }
  async connect(
    name: string,
    validate?: () => void,
    options: MCPRequestOptions = {},
  ): Promise<MCPServerState> {
    return this.runExclusive(async () => {
      options.signal?.throwIfAborted();
      const record = this.record(name);
      if (!record.client) {
        try {
          await this.commit(
            record,
            await this.candidate(record, validate, options),
          );
        } catch (error) {
          this.failed(record, error);
          throw error;
        }
      } else {
        await this.authorize(record);
        options.signal?.throwIfAborted();
        validate?.();
      }
      return this.requiredState(name);
    });
  }
  async reload(
    name: string,
    config?: MCPServerConfig,
    validate?: () => void,
  ): Promise<MCPServerState> {
    const snapshot = config && MCPServerConfigSchema.parse(config);
    return this.runExclusive(async () => {
      const current = this.record(name);
      if (snapshot && snapshot.name !== name) {
        throw new Error("MCP reload cannot rename a server");
      }
      const record = { ...current, config: snapshot ?? current.config };
      if (
        JSON.stringify(record.config.oauth) !==
          JSON.stringify(current.config.oauth) ||
        record.config.url !== current.config.url
      ) {
        record.oauth = undefined;
      }
      if (record.config.enabled === false) {
        await this.authorize(record);
        validate?.();
        await this.disconnectNow(current);
        current.config = record.config;
        this.changed();
        return this.requiredState(name);
      }
      const candidate = await this.candidate(record, validate);
      await this.commit(record, candidate);
      return this.requiredState(name);
    });
  }
  private async disconnectNow(record: ServerRecord): Promise<void> {
    record.unsubscribe?.();
    record.unsubscribe = undefined;
    const names = record.tools.map((tool) =>
      buildMcpToolName(record.config.name, tool.name),
    );
    const registry = this.options.registry;
    if (registry && names.some((name) => registry.get(name))) {
      registry.replaceTools(names, []);
    }
    const client = record.client;
    record.client = undefined;
    record.tools = [];
    record.state = "registered";
    record.failure = undefined;
    this.changed();
    await client?.disconnect();
  }
  async disconnect(name: string, validate?: () => void): Promise<void> {
    return this.runExclusive(async () => {
      validate?.();
      await this.disconnectNow(this.record(name));
    });
  }
  async unregisterServer(
    name: string,
    source: MCPSource,
    validate?: () => void,
  ): Promise<void> {
    return this.runExclusive(async () => {
      this.assertSource(source);
      const record = this.record(name);
      if (record.source !== source) {
        throw new Error("MCP server belongs to another source owner");
      }
      validate?.();
      await this.disconnectNow(record);
      this.records.delete(name);
      this.changed();
    });
  }
  async unregisterOwner(source: MCPSource): Promise<void> {
    this.assertSource(source);
    this.revokedSources.add(source);
    this.changed();
    return this.runExclusive(async () => {
      for (const [name, record] of this.records) {
        if (record.source === source) {
          await this.disconnectNow(record);
          this.records.delete(name);
        }
      }
      this.changed();
    });
  }
  async setExposure(
    name: string,
    exposure: MCPExposure,
    toolExposure?: MCPServerConfig["tool_exposure"],
    validate?: () => void,
  ): Promise<void> {
    const snapshot = toolExposure && structuredClone(toolExposure);
    return this.runExclusive(async () => {
      const current = this.record(name);
      const record = {
        ...current,
        config: MCPServerConfigSchema.parse({
          ...current.config,
          exposure,
          tool_exposure: snapshot,
        }),
      };
      await this.authorize(record);
      validate?.();
      if (record.client) {
        this.options.registry?.replaceTools(
          record.tools.map((tool) => buildMcpToolName(name, tool.name)),
          this.wrappers(record, record.client, record.tools),
        );
      }
      current.config = record.config;
      current.client?.updateConfig(current.config);
      this.changed();
    });
  }
  canInvoke(server: string, name: string, entry: ToolInvocationEntry): boolean {
    const record = this.records.get(server);
    if (
      !record?.client ||
      record.state !== "connected" ||
      this.revokedSources.has(record.source)
    ) {
      return false;
    }
    const registry = this.options.registry;
    if (registry) {
      return registry.canInvoke(buildMcpToolName(server, name), entry);
    }
    const exposure = resolveMCPExposure(record.config, name);
    if (
      exposure === "hidden" ||
      exposure === "codemode" ||
      entry === "codemode"
    ) {
      return false;
    }
    const tool = record.tools.find((tool) => tool.name === name);
    if (!tool) {
      return false;
    }
    return entry !== "dispatch" || exposure === "deferred";
  }
  canReadResources(name: string, toolName = MCP_RESOURCE_READ_TOOL): boolean {
    const record = this.records.get(name);
    return Boolean(
      record?.client &&
      !this.revokedSources.has(record.source) &&
      record.state === "connected" &&
      record.config.exposure !== "hidden" &&
      record.config.exposure !== "codemode" &&
      (!this.options.registry ||
        this.options.registry.canInvoke(toolName, "resource")),
    );
  }
  private async oauthProvider(
    name: string,
    validate?: () => void,
  ): Promise<MCPOAuthProvider> {
    const record = this.record(name);
    await this.authorize(record);
    validate?.();
    const config = expandMcpServerConfigEnvironment(
      record.config,
      record.config.inherit_env === false
        ? {}
        : (this.options.clientOptions?.environment ?? process.env),
    );
    if (
      config.enabled === false ||
      !config.oauth ||
      !config.url ||
      !this.options.oauth
    ) {
      throw new Error("MCP OAuth is not configured by host");
    }
    record.oauth ??= new MCPOAuthProvider(
      config.url,
      config.oauth,
      this.options.oauth,
    );
    return record.oauth;
  }
  async login(
    name: string,
    options: MCPLoginOptions,
    validate?: () => void,
  ): Promise<void> {
    const provider = await this.oauthProvider(name, validate);
    validate?.();
    await provider.login(options);
  }
  async logout(name: string, validate?: () => void): Promise<void> {
    const provider = await this.oauthProvider(name, validate);
    validate?.();
    await provider.logout();
    await this.disconnect(name);
  }
  async oauthState(name: string) {
    return (await this.oauthProvider(name)).status();
  }
  async connectAll(
    configs: MCPServerConfig[],
    source: MCPSource = this.globalSource,
  ): Promise<ConnectResult> {
    return this.runExclusive(() => this.connectAllNow(configs, source));
  }
  private async connectAllNow(
    configs: MCPServerConfig[],
    source: MCPSource,
  ): Promise<ConnectResult> {
    this.assertSource(source);
    configs = configs.map((config) => MCPServerConfigSchema.parse(config));
    if (
      new Set(configs.map((config) => sanitizeSegment(config.name))).size !==
      configs.length
    ) {
      throw new Error("MCP server name/source collision");
    }
    for (const config of configs) {
      const existing = this.records.get(config.name);
      if (existing && existing.source !== source) {
        throw new Error("MCP server belongs to another source owner");
      }
      if (
        !existing &&
        [...this.records.keys()].some(
          (name) => sanitizeSegment(name) === sanitizeSegment(config.name),
        )
      ) {
        throw new Error("MCP server name/source collision");
      }
    }
    const result: ConnectResult = {
      tools: [],
      servers: [],
      errors: [],
      instructions: [],
    };
    const pending: ServerRecord[] = [];
    for (const config of configs) {
      const existing = this.records.get(config.name);
      if (config.enabled === false || existing?.client) {
        continue;
      }
      pending.push(existing ?? this.registerNow(config, source));
    }
    const candidates = await Promise.all(
      pending.map(async (record) => {
        try {
          return { record, candidate: await this.candidate(record) };
        } catch (error) {
          return { record, error };
        }
      }),
    );
    const failures: unknown[] = [];
    for (const outcome of candidates) {
      const { record, candidate } = outcome;
      if (!candidate) {
        this.failed(record, outcome.error);
        if (isOptionalMCPConnectionError(outcome.error)) {
          result.errors.push({
            serverName: outcome.error.diagnostic.serverName,
            error: outcome.error.diagnostic.message,
            diagnostic: outcome.error.diagnostic,
          });
        } else {
          failures.push(outcome.error);
        }
        continue;
      }
      try {
        await this.commit(record, candidate);
      } catch (error) {
        this.failed(record, error);
        failures.push(error);
        continue;
      }
      result.servers.push(record.config.name);
      result.tools.push(
        ...candidate.tools.map((tool) => ({
          serverName: record.config.name,
          tool,
        })),
      );
      const text = candidate.client.getInstructions();
      if (text) {
        result.instructions.push({ serverName: record.config.name, text });
      }
    }
    if (failures.length > 0) {
      throw failures[0];
    }
    return result;
  }
  async reconnectAll(
    configs: MCPServerConfig[],
    source: MCPSource = this.globalSource,
  ): Promise<ConnectResult> {
    return this.runExclusive(async () => {
      this.assertSource(source);
      if (
        new Set(configs.map((config) => config.name)).size !== configs.length
      ) {
        throw new Error("MCP server name/source collision");
      }
      for (const config of configs) {
        MCPServerConfigSchema.parse(config);
      }
      for (const [name, record] of this.records) {
        if (record.source === source) {
          await this.disconnectNow(record);
          this.records.delete(name);
        }
      }
      return this.connectAllNow(configs, source);
    });
  }
  getClient(name: string): MCPClient | undefined {
    return this.records.get(name)?.client;
  }
  connectedServers(): string[] {
    return this.states()
      .filter((state) => state.state === "connected")
      .map((state) => state.name);
  }
  connectedInstructions(): { serverName: string; text: string }[] {
    return this.connectedServers().flatMap((serverName) => {
      const text = this.getClient(serverName)?.getInstructions();
      return text ? [{ serverName, text }] : [];
    });
  }
  missingServers(configs: MCPServerConfig[]): string[] {
    return configs
      .filter(
        (config) =>
          config.enabled !== false && !this.records.get(config.name)?.client,
      )
      .map((config) => config.name);
  }
  async disconnectAll(): Promise<void> {
    return this.runExclusive(async () => {
      for (const record of this.records.values()) {
        await this.disconnectNow(record);
      }
    });
  }
}

export async function connectRegisteredMCPServers(
  manager: MCPManager,
  serverNames: readonly string[],
  options: MCPRequestOptions = {},
): Promise<MCPConnectionDiagnostic[]> {
  const diagnostics: MCPConnectionDiagnostic[] = [];
  for (const name of serverNames) {
    options.signal?.throwIfAborted();
    try {
      await manager.connect(name, undefined, options);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!isOptionalMCPConnectionError(error)) {
        throw error;
      }
      diagnostics.push(error.diagnostic);
    }
  }
  return diagnostics;
}
