import { randomUUID } from "node:crypto";

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolResultSchema,
  type CallToolResult,
  type Resource,
  type ResourceTemplate,
  ResourceListChangedNotificationSchema,
  ResourceSchema,
  ResourceTemplateSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { registerExitCleanup } from "@/bootstrap/exit-cleanup.js";
import { version } from "@/bootstrap/version.js";
import {
  asImageMediaType,
  maybeResizeAndDownsampleImage,
} from "@/images/index.js";
import { createChildLogger } from "@/logger/index.js";
import { MCPServerConfigSchema, type MCPServerConfig } from "@/mcp/config.js";
import {
  MCP_APPS_EXTENSION,
  MCP_APP_MIME_TYPE,
  MCP_APP_URI_PREFIX,
  MCP_IMAGE_MEDIA_TYPES,
  MCP_NOT_CONNECTED_ERROR,
  MCP_MAX_PAGES,
  MCP_MAX_LIST_ITEMS,
  MCP_MAX_CURSOR_BYTES,
  MCP_RESOURCE_CURSOR_PREFIX,
  MCP_REQUEST_TIMEOUT_MS,
  MCP_RESOURCE_MAX_BYTES,
  MCP_RESOURCE_LIST_TOOL,
  MCP_RESOURCE_READ_TOOL,
  MCP_RESOURCE_URI_LIMIT,
} from "@/mcp/constants.js";
import { mcpConnectionError } from "@/mcp/errors.js";
import type { MCPOAuthProvider } from "@/mcp/oauth.js";
import { resolveMCPExposure } from "@/mcp/policy.js";
import type { ToolInvocationEntry } from "@/mcp/policy.js";
import type {
  ToolResult,
  ToolResultContentBlock,
  ToolSchema,
} from "@/tools/types.js";
import { cancelOnSignal } from "@/utils/cancel.js";
import { isRecord } from "@/utils/record.js";

const log = createChildLogger({ module: "mcp" });
type MCPTransport = StdioClientTransport | StreamableHTTPClientTransport;

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: ToolSchema["input_schema"];
  _meta?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; [key: string]: unknown };
}

export interface MCPRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxPages?: number;
  maxItems?: number;
}
export interface MCPClientOptions {
  oauth?: MCPOAuthProvider;
  environment?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
}
export interface MCPResourcePageOptions extends MCPRequestOptions {
  cursor?: string;
  limit?: number;
}
export interface MCPResourcePage<T> {
  items: T[];
  nextCursor?: string;
}
export interface MCPCallResult extends ToolResult {
  structuredContent?: CallToolResult["structuredContent"];
  mcpResult: CallToolResult;
}

function requestSignal(options: MCPRequestOptions): AbortSignal {
  const timeout = AbortSignal.timeout(
    Math.max(
      1,
      Math.min(
        options.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS,
        MCP_REQUEST_TIMEOUT_MS,
      ),
    ),
  );
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

// Claude-compatible environment expansion. Missing required variables fail the
// connection instead of silently becoming an empty command, URL, or credential.
function expandEnv(value: string, environment: NodeJS.ProcessEnv): string {
  return value.replace(
    /\$\{([A-Za-z_]\w*)(?::-([^}]*))?\}|\$([A-Za-z_]\w*)/g,
    (
      _match,
      braced: string | undefined,
      fallback: string | undefined,
      bare: string | undefined,
    ) => {
      const name = braced ?? bare ?? "";
      const resolved = environment[name];
      if (resolved !== undefined) {
        return resolved;
      }
      if (fallback !== undefined) {
        return fallback;
      }
      throw new Error(
        `MCP config references unset environment variable "${name}"`,
      );
    },
  );
}

/**
 * Expands environment references in every location supported by project
 * `.mcp.json` files without mutating either the config or `process.env`.
 */
export function expandMcpServerConfigEnvironment(
  config: MCPServerConfig,
  environment: NodeJS.ProcessEnv = process.env,
): MCPServerConfig {
  config = MCPServerConfigSchema.parse(config);
  if (config.enabled === false) {
    return config;
  }
  const expandedEnv =
    config.env &&
    Object.fromEntries(
      Object.entries(config.env).map(([key, value]) => [
        key,
        expandEnv(value, environment),
      ]),
    );
  environment = { ...environment, ...expandedEnv };
  const expanded = {
    ...config,
    command:
      config.command === undefined
        ? undefined
        : expandEnv(config.command, environment),
    args: config.args?.map((arg) => expandEnv(arg, environment)),
    url:
      config.url === undefined ? undefined : expandEnv(config.url, environment),
    env: expandedEnv,
    headers:
      config.headers === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(config.headers).map(([key, value]) => [
              key,
              expandEnv(value, environment),
            ]),
          ),
  };
  if (expanded.url) {
    validateMCPEndpoint(expanded.url);
  }
  return MCPServerConfigSchema.parse(expanded);
}

export function validateMCPEndpoint(value: string): URL {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("MCP endpoint requires HTTP(S) without URL credentials");
  }
  return url;
}

function asDict(
  obj: Record<string, string | undefined>,
): Record<string, string> {
  const dict: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    dict[k] = v ?? "";
  }
  return dict;
}

export async function mcpContentToToolOutput(
  content: unknown[],
): Promise<Pick<ToolResult, "output" | "contentBlocks">> {
  const textParts: string[] = [];
  const contentBlocks: ToolResultContentBlock[] = [];
  let hasImage = false;

  for (const raw of content) {
    const c = isRecord(raw) ? raw : {};
    if (
      c.type === "image" &&
      typeof c.data === "string" &&
      typeof c.mimeType === "string" &&
      MCP_IMAGE_MEDIA_TYPES.has(c.mimeType)
    ) {
      try {
        const resized = await maybeResizeAndDownsampleImage(
          Buffer.from(c.data, "base64"),
          asImageMediaType(c.mimeType),
        );
        contentBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: resized.mediaType,
            data: resized.data,
          },
        });
        textParts.push(`[Image: ${resized.mediaType}]`);
        hasImage = true;
        continue;
      } catch {
        log.warn("mcp image dropped (too large to fit the API limit)");
        const note =
          "[note: an image returned by the tool was too large and was dropped]";
        textParts.push(note);
        contentBlocks.push({ type: "text", text: note });
        continue;
      }
    }

    if (c.type === "image") {
      const mimeType = typeof c.mimeType === "string" ? c.mimeType : "unknown";
      const note = `[Unsupported image: ${mimeType}]`;
      textParts.push(note);
      contentBlocks.push({ type: "text", text: note });
      continue;
    }

    const serialized = JSON.stringify(raw);
    const text =
      c.type === "text" && typeof c.text === "string"
        ? c.text
        : typeof serialized === "string"
          ? serialized
          : String(raw);
    textParts.push(text);
    contentBlocks.push({ type: "text", text });
  }

  const output = textParts.join("\n");
  return hasImage ? { output, contentBlocks } : { output };
}

export class MCPClient {
  name: string;
  private config: MCPServerConfig;
  private client: Client | null = null;
  private transport: MCPTransport | null = null;
  private unregisterExitCleanup: (() => void) | null = null;
  private tools = new Map<string, MCPTool>();
  readonly appsEnabled: boolean;
  private listeners = new Set<(kind: "tools" | "resources") => void>();
  private guard?: (name: string, entry: ToolInvocationEntry) => boolean;
  private resourceCursors = new Map<
    string,
    { kind: string; items: unknown[]; nextCursor?: string }
  >();

  constructor(
    config: MCPServerConfig,
    appsEnabled = false,
    private options: MCPClientOptions = {},
  ) {
    this.name = config.name;
    this.config = config;
    this.appsEnabled = appsEnabled;
  }
  onListChanged(listener: (kind: "tools" | "resources") => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  setInvocationGuard(
    guard: (name: string, entry: ToolInvocationEntry) => boolean,
  ): void {
    this.guard = guard;
  }
  updateConfig(config: MCPServerConfig): void {
    this.config = config;
  }
  private assertInvocation(name: string, entry: ToolInvocationEntry): void {
    const exposure = resolveMCPExposure(this.config, name);
    if (
      exposure === "hidden" ||
      (exposure === "codemode" && entry !== "codemode") ||
      (entry === "codemode" && !this.guard) ||
      this.guard?.(name, entry) === false
    ) {
      throw new Error("MCP tool invocation is unavailable or revoked");
    }
  }

  async connect(options: MCPRequestOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    if (this.config.enabled === false) {
      throw new Error(`MCP server "${this.config.name}" is disabled`);
    }
    if (this.client) {
      throw new Error("MCP client is already connected");
    }
    const environment =
      this.config.inherit_env === false
        ? {}
        : (this.options.environment ?? process.env);
    const config = expandMcpServerConfigEnvironment(this.config, environment);
    const signal = requestSignal(options);
    if (config.command) {
      const env: NodeJS.ProcessEnv = { ...environment };
      if (config.env) {
        for (const [k, v] of Object.entries(config.env)) {
          env[k] = v;
        }
      }

      this.transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        cwd: config.cwd,
        env: asDict(env),
        stderr: "ignore",
      });
    } else if (config.url) {
      const url = validateMCPEndpoint(config.url);
      const headers = config.headers ?? {};
      const transportFetch =
        this.options.oauth?.transportFetch ?? this.options.fetch ?? fetch;
      const guardedFetch: FetchLike = async (input, init) => {
        const target = validateMCPEndpoint(
          input instanceof Request ? input.url : String(input),
        );
        if (target.origin !== url.origin) {
          throw new Error(
            "MCP transport endpoint crossed its authorized origin",
          );
        }
        if (this.options.oauth && !(await this.options.oauth.tokens())) {
          throw new UnauthorizedError();
        }
        const response = await transportFetch(input, {
          ...init,
          redirect: "error",
        });
        if (
          response.redirected ||
          (response.status >= 300 && response.status < 400)
        ) {
          throw new Error("MCP transport redirects are forbidden");
        }
        return response;
      };

      this.transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers, redirect: "error" },
        fetch: guardedFetch,
      });
    } else {
      throw new Error(
        `MCP server '${this.name}': needs either 'command' (stdio) or 'url' (Streamable HTTP)`,
      );
    }

    this.client = new Client(
      { name: "yukino", version },
      {
        capabilities: this.appsEnabled
          ? {
              extensions: {
                [MCP_APPS_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] },
              },
            }
          : {},
      },
    );
    this.client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      () => {
        for (const listener of this.listeners) {
          listener("tools");
        }
      },
    );
    this.client.setNotificationHandler(
      ResourceListChangedNotificationSchema,
      () => {
        this.resourceCursors.clear();
        for (const listener of this.listeners) {
          listener("resources");
        }
      },
    );
    const client = this.client;
    const transport = this.transport;
    try {
      await cancelOnSignal(
        () =>
          client.connect(transport, {
            signal,
            timeout: MCP_REQUEST_TIMEOUT_MS,
          }),
        signal,
      );
      options.signal?.throwIfAborted();
    } catch (error) {
      const failure = mcpConnectionError(
        config,
        "connect",
        error,
        options.signal,
      );
      await this.disconnect().catch(() => undefined);
      throw failure;
    }

    // A crash path (process.exit / uncaught exception) never awaits the async
    // disconnectAll, so a spawned stdio server would survive as an orphan.
    // Register a synchronous kill of the exact child PID — the SDK does not
    // spawn detached, so never signal a process group — and drop the hook on a
    // clean disconnect.
    if (this.transport instanceof StdioClientTransport) {
      const pid = this.transport.pid;
      if (typeof pid === "number" && pid > 0) {
        this.unregisterExitCleanup = registerExitCleanup(() => {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // The server already exited.
          }
        });
      }
    }
  }

  // The server's instructions from the initialize result, if any.
  getInstructions(): string {
    return this.client?.getInstructions() ?? "";
  }

  private async pages<T>(
    kind: string,
    options: MCPRequestOptions,
    fetchPage: (
      cursor: string | undefined,
      signal: AbortSignal,
    ) => Promise<{ items: T[]; nextCursor?: string }>,
  ): Promise<T[]> {
    const signal = requestSignal(options);
    const items: T[] = [];
    let bytes = 0;
    const cursors = new Set<string>();
    let cursor: string | undefined;
    const maxPages = Math.max(
      1,
      Math.min(options.maxPages ?? MCP_MAX_PAGES, MCP_MAX_PAGES),
    );
    const maxItems = Math.max(
      1,
      Math.min(options.maxItems ?? MCP_MAX_LIST_ITEMS, MCP_MAX_LIST_ITEMS),
    );
    for (let page = 0; page < maxPages; page++) {
      const result = await cancelOnSignal(
        () => fetchPage(cursor, signal),
        signal,
      );
      if (items.length + result.items.length > maxItems) {
        throw new Error(`MCP ${kind} item limit exceeded`);
      }
      bytes += Buffer.byteLength(JSON.stringify(result.items));
      if (bytes > MCP_RESOURCE_MAX_BYTES) {
        throw new Error(`MCP ${kind} byte limit exceeded`);
      }
      items.push(...result.items);
      cursor = result.nextCursor;
      if (cursor === undefined) {
        return items;
      }
      if (Buffer.byteLength(cursor) > MCP_MAX_CURSOR_BYTES) {
        throw new Error(`MCP ${kind} cursor limit exceeded`);
      }
      if (cursors.has(cursor)) {
        throw new Error(`MCP server '${this.name}' repeated ${kind} cursor`);
      }
      cursors.add(cursor);
    }
    throw new Error(`MCP ${kind} page limit exceeded`);
  }
  async listTools(options: MCPRequestOptions = {}): Promise<MCPTool[]> {
    const client = this.client;
    if (!client) {
      throw new Error(MCP_NOT_CONNECTED_ERROR);
    }
    const tools = await this.pages("tools", options, async (cursor, signal) => {
      const result = await client.listTools(
        cursor === undefined ? undefined : { cursor },
        { signal, timeout: MCP_REQUEST_TIMEOUT_MS },
      );
      return {
        items: result.tools.map(
          ({
            name,
            description,
            _meta,
            annotations,
            inputSchema: { properties, ...rest },
          }) => ({
            name,
            description: description ?? "",
            inputSchema: { ...rest, properties: properties ?? {} },
            ...(_meta ? { _meta } : {}),
            ...(annotations ? { annotations } : {}),
          }),
        ),
        nextCursor: result.nextCursor,
      };
    });
    const next = new Map(tools.map((tool) => [tool.name, tool]));
    if (next.size !== tools.length) {
      throw new Error("Duplicate MCP tool names");
    }
    this.tools = next;
    return tools;
  }
  private assertResourceAccess(toolName: string): void {
    if (
      this.config.exposure === "hidden" ||
      this.config.exposure === "codemode" ||
      this.guard?.(toolName, "resource") === false
    ) {
      throw new Error("MCP resource access unavailable");
    }
  }
  private async fetchResourcePage(
    client: Client,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<MCPResourcePage<Resource>> {
    this.assertResourceAccess(MCP_RESOURCE_LIST_TOOL);
    const result = await client.listResources(
      cursor === undefined ? undefined : { cursor },
      { signal, timeout: MCP_REQUEST_TIMEOUT_MS },
    );
    this.assertResourceAccess(MCP_RESOURCE_LIST_TOOL);
    return {
      items: result.resources.filter(
        (resource) => !resource.uri.startsWith(MCP_APP_URI_PREFIX),
      ),
      nextCursor: result.nextCursor,
    };
  }

  private async fetchTemplatePage(
    client: Client,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<MCPResourcePage<ResourceTemplate>> {
    this.assertResourceAccess(MCP_RESOURCE_LIST_TOOL);
    const result = await client.listResourceTemplates(
      cursor === undefined ? undefined : { cursor },
      { signal, timeout: MCP_REQUEST_TIMEOUT_MS },
    );
    this.assertResourceAccess(MCP_RESOURCE_LIST_TOOL);
    return {
      items: result.resourceTemplates.filter(
        (resource) => !resource.uriTemplate.startsWith(MCP_APP_URI_PREFIX),
      ),
      nextCursor: result.nextCursor,
    };
  }

  private resourceClient(): Client {
    this.assertResourceAccess(MCP_RESOURCE_LIST_TOOL);
    if (!this.client) {
      throw new Error(MCP_NOT_CONNECTED_ERROR);
    }
    return this.client;
  }

  async listResources(options: MCPRequestOptions = {}): Promise<Resource[]> {
    const client = this.resourceClient();
    return this.pages("resources", options, (cursor, signal) =>
      this.fetchResourcePage(client, cursor, signal),
    );
  }

  async listResourceTemplates(
    options: MCPRequestOptions = {},
  ): Promise<ResourceTemplate[]> {
    const client = this.resourceClient();
    return this.pages("resource templates", options, (cursor, signal) =>
      this.fetchTemplatePage(client, cursor, signal),
    );
  }

  private async resourcePage<T>(
    kind: string,
    options: MCPResourcePageOptions,
    fetchPage: (
      cursor: string | undefined,
      signal: AbortSignal,
    ) => Promise<MCPResourcePage<T>>,
    decode: (items: unknown[]) => T[],
  ): Promise<MCPResourcePage<T>> {
    this.assertResourceAccess(MCP_RESOURCE_LIST_TOOL);
    const signal = requestSignal(options);
    signal.throwIfAborted();
    const limit = options.limit ?? MCP_MAX_LIST_ITEMS;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MCP_MAX_LIST_ITEMS ||
      (options.cursor !== undefined &&
        (typeof options.cursor !== "string" ||
          Buffer.byteLength(options.cursor) > MCP_MAX_CURSOR_BYTES))
    ) {
      throw new Error("Invalid MCP resource pagination");
    }
    const cached =
      options.cursor === undefined
        ? undefined
        : this.resourceCursors.get(options.cursor);
    if (
      options.cursor?.startsWith(MCP_RESOURCE_CURSOR_PREFIX) &&
      cached?.kind !== kind
    ) {
      throw new Error("MCP resource cursor expired or belongs to another list");
    }
    const result = cached
      ? { items: decode(cached.items), nextCursor: cached.nextCursor }
      : await cancelOnSignal(() => fetchPage(options.cursor, signal), signal);
    if (
      result.items.length > MCP_MAX_LIST_ITEMS ||
      Buffer.byteLength(JSON.stringify(result.items)) >
        MCP_RESOURCE_MAX_BYTES ||
      (result.nextCursor !== undefined &&
        (Buffer.byteLength(result.nextCursor) > MCP_MAX_CURSOR_BYTES ||
          result.nextCursor === options.cursor))
    ) {
      throw new Error("MCP resource page exceeds bounds or repeats its cursor");
    }
    if (cached && options.cursor) {
      this.resourceCursors.delete(options.cursor);
    }
    let nextCursor = result.nextCursor;
    if (result.items.length > limit) {
      const remaining = result.items.slice(limit);
      const retainedBytes = [...this.resourceCursors.values()].reduce(
        (sum, page) => sum + Buffer.byteLength(JSON.stringify(page.items)),
        0,
      );
      if (
        this.resourceCursors.size >= MCP_MAX_PAGES ||
        retainedBytes + Buffer.byteLength(JSON.stringify(remaining)) >
          MCP_RESOURCE_MAX_BYTES
      ) {
        throw new Error("MCP resource cursor storage limit exceeded");
      }
      nextCursor = MCP_RESOURCE_CURSOR_PREFIX + randomUUID();
      this.resourceCursors.set(nextCursor, {
        kind,
        items: remaining,
        nextCursor: result.nextCursor,
      });
    }
    this.assertResourceAccess(MCP_RESOURCE_LIST_TOOL);
    signal.throwIfAborted();
    return {
      items: result.items.slice(0, limit),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }
  async listResourcesPage(
    options: MCPResourcePageOptions = {},
  ): Promise<MCPResourcePage<Resource>> {
    const client = this.resourceClient();
    return this.resourcePage(
      "resources",
      options,
      (cursor, signal) => this.fetchResourcePage(client, cursor, signal),
      (items) => items.map((item) => ResourceSchema.parse(item)),
    );
  }

  async listResourceTemplatesPage(
    options: MCPResourcePageOptions = {},
  ): Promise<MCPResourcePage<ResourceTemplate>> {
    const client = this.resourceClient();
    return this.resourcePage(
      "templates",
      options,
      (cursor, signal) => this.fetchTemplatePage(client, cursor, signal),
      (items) => items.map((item) => ResourceTemplateSchema.parse(item)),
    );
  }

  getTool(name: string): MCPTool | undefined {
    return this.tools.get(name);
  }

  async readResource(uri: string, signal?: AbortSignal) {
    if (uri.startsWith(MCP_APP_URI_PREFIX)) {
      throw new Error("MCP Apps resources require the dedicated Apps host");
    }
    this.assertResourceAccess(MCP_RESOURCE_READ_TOOL);
    return this.readResourceResult(uri, signal);
  }
  async readAppResource(uri: string, toolName: string, signal?: AbortSignal) {
    if (!this.appsEnabled || !uri.startsWith(MCP_APP_URI_PREFIX)) {
      throw new Error("Invalid MCP Apps resource");
    }
    this.assertInvocation(toolName, "app");
    return this.readResourceResult(uri, signal);
  }
  private async readResourceResult(uri: string, signal?: AbortSignal) {
    if (uri.length > MCP_RESOURCE_URI_LIMIT) {
      throw new Error("MCP resource URI limit exceeded");
    }
    signal?.throwIfAborted();
    const client = this.client;
    if (!client) {
      throw new Error(MCP_NOT_CONNECTED_ERROR);
    }
    const bounded = requestSignal({ signal });
    const result = await cancelOnSignal(
      () =>
        client.readResource(
          { uri },
          { signal: bounded, timeout: MCP_REQUEST_TIMEOUT_MS },
        ),
      bounded,
    );
    if (
      Buffer.byteLength(JSON.stringify(result)) >
      MCP_RESOURCE_MAX_BYTES * 2
    ) {
      throw new Error("MCP resource response exceeds byte limit");
    }
    return result;
  }

  async callToolResult(
    name: string,
    args: Record<string, unknown>,
    abortSignal?: AbortSignal,
    entry: ToolInvocationEntry = "direct",
  ): Promise<CallToolResult> {
    abortSignal?.throwIfAborted();
    this.assertInvocation(name, entry);
    const client = this.client;
    if (!client) {
      throw new Error(MCP_NOT_CONNECTED_ERROR);
    }
    const signal = requestSignal({ signal: abortSignal });
    return CallToolResultSchema.parse(
      await cancelOnSignal(
        () =>
          client.callTool({ name, arguments: args }, CallToolResultSchema, {
            signal,
            timeout: MCP_REQUEST_TIMEOUT_MS,
          }),
        signal,
      ),
    );
  }

  /** Calls a tool and preserves both its text fallback and provider-native rich content. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    abortSignal?: AbortSignal,
    entry: ToolInvocationEntry = "direct",
  ): Promise<MCPCallResult> {
    const result = await this.callToolResult(name, args, abortSignal, entry);
    const converted = await mcpContentToToolOutput(result.content);
    const ui = this.tools.get(name)?._meta?.ui;
    const resourceUri = isRecord(ui) ? ui.resourceUri : undefined;
    return {
      ...converted,
      mcpResult: result,
      rawContent: result.content,
      ...(result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent }
        : {}),
      isError: result.isError === true,
      ...(this.appsEnabled &&
      typeof resourceUri === "string" &&
      resourceUri.startsWith(MCP_APP_URI_PREFIX)
        ? {
            mcpApp: {
              serverName: this.name,
              toolName: name,
              resourceUri,
              arguments: args,
              result,
            },
          }
        : {}),
    };
  }

  async disconnect(): Promise<void> {
    this.resourceCursors.clear();
    this.unregisterExitCleanup?.();
    this.unregisterExitCleanup = null;
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    let clientClosed = false;
    try {
      await client?.close();
      clientClosed = true;
    } catch {
      log.error("mcp operation failed");
    }
    if (!clientClosed && transport) {
      try {
        await transport.close();
      } catch {
        log.error("mcp transport close failed");
      }
    }
  }
}
