import { createHash, randomUUID } from "node:crypto";

import { expandMcpServerConfigEnvironment } from "@/mcp/client.js";
import type { MCPExposure, MCPServerConfig } from "@/mcp/config.js";
import {
  MCP_RESOURCE_LIST_TOOL,
  MCP_RESOURCE_READ_TOOL,
  SDK_MCP_RESOURCE_RECORD,
  SDK_UNKNOWN_MCP_ERROR,
} from "@/mcp/constants.js";
import type { MCPManager, MCPSource } from "@/mcp/manager.js";
import type { MCPLoginOptions } from "@/mcp/oauth.js";
import {
  mcpRegistrationPreview,
  prepareRuntimeMCPServer,
} from "@/mcp/registration.js";
import { previewMCPResource } from "@/mcp/resources.js";
import { decideAndApply } from "@/mcp/strategy.js";
import { requestToolPermission } from "@/permissions/request.js";
import { authorizeRuntimeTool } from "@/runtime/authorization.js";
import type { AgentRuntime } from "@/runtime/types.js";
import type { SessionManager } from "@/session/manager.js";
import { assertBoundedJson } from "@/session/records.js";
import type { PermissionRequestHandler } from "@/tools/types.js";

export class MCPManagement {
  private source?: MCPSource;
  private authorization?: () => void;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly session: SessionManager,
    private readonly permission: PermissionRequestHandler,
  ) {}

  private get manager(): MCPManager {
    const manager = this.runtime.mcpManager;
    if (!manager) {
      throw new Error(SDK_UNKNOWN_MCP_ERROR);
    }
    return manager;
  }

  private existingConfig(name: string): MCPServerConfig {
    const manager = this.manager;
    const config = manager.getServerConfig(name);
    const state = manager.state(name);
    return state?.source.scope === "global"
      ? expandMcpServerConfigEnvironment(config, process.env)
      : expandMcpServerConfigEnvironment(config, config.env ?? {});
  }

  private runtimeSource(): MCPSource {
    const manager = this.manager;
    if (
      !this.source ||
      !manager.states().some((state) => state.source === this.source)
    ) {
      const source = manager.createRuntimeSource(
        `session:${this.session.id}`,
        () => {
          if (!this.authorization) {
            return false;
          }
          try {
            this.authorization();
            return true;
          } catch {
            return false;
          }
        },
      );
      this.source = source;
      this.runtime.registry.addCleanup(() => manager.unregisterOwner(source));
    }
    return this.source;
  }

  private async refresh(): Promise<void> {
    const runtime = this.runtime;
    await runtime.refreshMcpTools?.();
    decideAndApply(
      runtime.registry,
      runtime.provider.base_url,
      runtime.provider.protocol,
    );
  }

  private async manage<T>(
    config: MCPServerConfig,
    operation: "MCPRegister" | "MCPConnect",
    action: string,
    signal: AbortSignal,
    execute: (validate: () => void) => Promise<T>,
    spawning = false,
  ): Promise<T> {
    const runtime = this.runtime;
    const manager = this.manager;
    const generation = manager.generation;
    const registryGeneration = runtime.registry.generation;
    const preview = { ...mcpRegistrationPreview(config), action };
    const command = [config.command ?? "", ...(config.args ?? [])]
      .map((part) =>
        /^[\w@%+=:,./-]+$/u.test(part)
          ? part
          : `'${part.replaceAll("'", "'\\''")}'`,
      )
      .join(" ");
    const needsBash =
      spawning && config.enabled !== false && Boolean(config.command);
    const checker = config.cwd
      ? runtime.checker.forCwd(config.cwd)
      : runtime.checker;
    const decisions = () => [
      runtime.checker.check(operation, "command", preview),
      ...(needsBash ? [checker.check("Bash", "command", { command })] : []),
    ];
    const validate = () => {
      signal.throwIfAborted();
      if (
        generation !== manager.generation ||
        registryGeneration !== runtime.registry.generation ||
        runtime.registry.getPolicy().role === "readonly" ||
        runtime.registry.getPolicy().denylist?.includes(operation) ||
        decisions().some((decision) => decision.effect === "deny") ||
        (needsBash &&
          (!runtime.registry.canInvoke("Bash", "host") ||
            runtime.toolFilter?.("Bash") === false))
      ) {
        throw new Error("MCP operation denied or authorization revoked");
      }
    };
    validate();
    for (const name of [operation, ...(needsBash ? ["Bash"] : [])]) {
      const hook = await runtime.hookEngine?.firePreToolHooks(name, preview, {
        cwd: config.cwd ?? runtime.cwd,
        abortSignal: signal,
      });
      if (hook?.rejected) {
        throw new Error("MCP operation rejected by hook");
      }
      validate();
    }
    if (decisions().some((decision) => decision.effect === "ask")) {
      const response = await requestToolPermission(
        this.permission,
        operation,
        preview,
        { effect: "ask", reason: `Authorize MCP ${action} for ${config.name}` },
        randomUUID(),
        signal,
      );
      if (response !== "allow" && response !== "allowAlways") {
        throw new Error("MCP operation requires approval");
      }
    }
    validate();
    this.authorization = validate;
    try {
      return await execute(validate);
    } finally {
      this.authorization = undefined;
    }
  }

  register(config: MCPServerConfig, signal: AbortSignal) {
    assertBoundedJson(config);
    const prepared = prepareRuntimeMCPServer(structuredClone(config));
    return this.manage(
      prepared,
      "MCPRegister",
      "register",
      signal,
      async (validate) => {
        const manager = this.manager;
        const source = this.runtimeSource();
        const state =
          prepared.enabled === false
            ? await manager.registerServer(prepared, source, validate)
            : await manager.registerAndConnect(prepared, source, validate);
        await this.refresh();
        return state;
      },
      true,
    );
  }

  connect(name: string, signal: AbortSignal) {
    return this.manage(
      this.existingConfig(name),
      "MCPConnect",
      "connect",
      signal,
      async (validate) => {
        const state = await this.manager.connect(name, validate, { signal });
        await this.refresh();
        return state;
      },
      true,
    );
  }

  disconnect(name: string, signal: AbortSignal): Promise<void> {
    return this.manage(
      this.existingConfig(name),
      "MCPConnect",
      "disconnect",
      signal,
      async (validate) => {
        await this.manager.disconnect(name, validate);
        await this.refresh();
      },
    );
  }

  reload(
    name: string,
    config: MCPServerConfig | undefined,
    signal: AbortSignal,
  ) {
    if (config) {
      assertBoundedJson(config);
    }
    const prepared = config
      ? prepareRuntimeMCPServer(structuredClone(config))
      : this.existingConfig(name);
    if (prepared.name !== name) {
      throw new Error("MCP reload cannot rename a server");
    }
    return this.manage(
      prepared,
      "MCPConnect",
      "reload",
      signal,
      async (validate) => {
        const state = await this.manager.reload(name, prepared, validate);
        await this.refresh();
        return state;
      },
      true,
    );
  }

  unregister(name: string, signal: AbortSignal): Promise<void> {
    const source = this.manager.state(name)?.source;
    if (!source || source !== this.source) {
      throw new Error(SDK_UNKNOWN_MCP_ERROR);
    }
    return this.manage(
      this.existingConfig(name),
      "MCPRegister",
      "unregister",
      signal,
      async (validate) => {
        await this.manager.unregisterServer(name, source, validate);
        await this.refresh();
      },
    );
  }

  setExposure(
    server: string,
    exposure: MCPExposure,
    rules: MCPServerConfig["tool_exposure"],
    signal: AbortSignal,
  ): Promise<void> {
    if (rules) {
      assertBoundedJson(rules);
    }
    const snapshot = rules && structuredClone(rules);
    const config = {
      ...this.existingConfig(server),
      exposure,
      tool_exposure: snapshot,
    };
    return this.manage(
      config,
      "MCPRegister",
      "exposure",
      signal,
      async (validate) => {
        await this.manager.setExposure(server, exposure, snapshot, validate);
        await this.refresh();
      },
    );
  }

  login(
    server: string,
    options: MCPLoginOptions,
    signal: AbortSignal,
  ): Promise<void> {
    const snapshot = { ...options };
    const loginSignal = snapshot.signal
      ? AbortSignal.any([signal, snapshot.signal])
      : signal;
    return this.manage(
      this.existingConfig(server),
      "MCPConnect",
      "login",
      loginSignal,
      (validate) =>
        this.manager.login(
          server,
          { ...snapshot, signal: loginSignal },
          validate,
        ),
    );
  }

  logout(server: string, signal: AbortSignal): Promise<void> {
    return this.manage(
      this.existingConfig(server),
      "MCPConnect",
      "logout",
      signal,
      async (validate) => {
        await this.manager.logout(server, validate);
        await this.refresh();
      },
    );
  }

  private async authorizeResource(
    server: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<() => void> {
    const runtime = this.runtime;
    const manager = this.manager;
    const generation = manager.generation;
    await authorizeRuntimeTool(
      runtime,
      name,
      args,
      signal,
      this.permission,
      "host",
    );
    const authorization = runtime.registry.captureAuthorization(name, "host");
    const validate = () => {
      signal.throwIfAborted();
      if (
        generation !== manager.generation ||
        !manager.canReadResources(server, name) ||
        !runtime.registry.validateAuthorization(authorization) ||
        runtime.toolFilter?.(name) === false ||
        runtime.checker.check(name, "read", args).effect === "deny"
      ) {
        throw new Error("MCP resource access revoked");
      }
    };
    validate();
    return validate;
  }

  async listResources(
    server: string,
    options: {
      templates?: boolean;
      cursor?: string;
      limit?: number;
      signal?: AbortSignal;
    },
    signal: AbortSignal,
  ) {
    const snapshot = { ...options };
    const client = this.manager.getClient(server);
    if (
      !client ||
      !this.manager.canReadResources(server, MCP_RESOURCE_LIST_TOOL)
    ) {
      throw new Error(SDK_UNKNOWN_MCP_ERROR);
    }
    const resourceSignal = snapshot.signal
      ? AbortSignal.any([signal, snapshot.signal])
      : signal;
    const validate = await this.authorizeResource(
      server,
      MCP_RESOURCE_LIST_TOOL,
      { server, templates: snapshot.templates },
      resourceSignal,
    );
    const page = snapshot.templates
      ? await client.listResourceTemplatesPage({
          ...snapshot,
          signal: resourceSignal,
        })
      : await client.listResourcesPage({ ...snapshot, signal: resourceSignal });
    validate();
    return page;
  }

  async readResource(
    server: string,
    uri: string,
    options: { signal?: AbortSignal },
    signal: AbortSignal,
  ) {
    const client = this.manager.getClient(server);
    if (!client || !this.manager.canReadResources(server)) {
      throw new Error(SDK_UNKNOWN_MCP_ERROR);
    }
    const resourceSignal = options.signal
      ? AbortSignal.any([signal, options.signal])
      : signal;
    const validate = await this.authorizeResource(
      server,
      MCP_RESOURCE_READ_TOOL,
      { server, uri },
      resourceSignal,
    );
    const resource = await client.readResource(uri, resourceSignal);
    validate();
    const result = await previewMCPResource(
      server,
      resource,
      {
        create: (data, mimeType, provenance) =>
          Promise.resolve({
            id: this.session.appendArtifact(data, mimeType),
            mimeType,
            bytes: data.byteLength,
            sha256: createHash("sha256").update(data).digest("hex"),
            ...provenance,
          }),
      },
      resourceSignal,
    );
    validate();
    this.session.append({
      role: "system",
      type: SDK_MCP_RESOURCE_RECORD,
      timestamp: Date.now() / 1000,
      content: JSON.stringify({
        server,
        uri,
        artifacts: result.resourceArtifacts.map(
          ({ serverName, uri: resourceUri, id, mimeType, bytes, sha256 }) => ({
            serverName,
            uri: resourceUri,
            mimeType,
            bytes,
            sha256,
            source: { type: "artifact", artifactId: id },
          }),
        ),
      }),
    });
    return result;
  }
}
