import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { registerExitCleanup } from "@/bootstrap/exit-cleanup.js";
import type { MCPServerConfig } from "@/config/index.js";
import {
  asImageMediaType,
  maybeResizeAndDownsampleImage,
} from "@/images/index.js";
import { createChildLogger } from "@/logger/index.js";
import {
  MCP_APPS_EXTENSION,
  MCP_APP_MIME_TYPE,
  MCP_APP_URI_PREFIX,
  MCP_IMAGE_MEDIA_TYPES,
  MCP_NOT_CONNECTED_ERROR,
} from "@/mcp/constants.js";
import type {
  ToolResult,
  ToolResultContentBlock,
  ToolSchema,
} from "@/tools/types.js";
import { isRecord } from "@/utils/index.js";
import { version } from "@/version.js";

const log = createChildLogger({ module: "mcp" });
type MCPTransport =
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: ToolSchema["input_schema"];
  _meta?: Record<string, unknown>;
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
  return {
    ...config,
    command:
      config.command === undefined
        ? undefined
        : expandEnv(config.command, environment),
    args: config.args?.map((arg) => expandEnv(arg, environment)),
    url:
      config.url === undefined ? undefined : expandEnv(config.url, environment),
    env:
      config.env === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(config.env).map(([key, value]) => [
              key,
              expandEnv(value, environment),
            ]),
          ),
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
      } catch (err) {
        log.warn({ err }, "mcp image dropped (too large to fit the API limit)");
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

  constructor(config: MCPServerConfig, appsEnabled = false) {
    this.name = config.name;
    this.config = config;
    this.appsEnabled = appsEnabled;
  }

  async connect(): Promise<void> {
    if (this.config.enabled === false) {
      throw new Error(`MCP server "${this.config.name}" is disabled`);
    }
    const config = expandMcpServerConfigEnvironment(this.config);
    if (config.command) {
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (config.env) {
        for (const [k, v] of Object.entries(config.env)) {
          env[k] = v;
        }
      }

      this.transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: asDict(env),
        stderr: "ignore",
      });
    } else if (config.url) {
      const url = new URL(config.url);
      const headers = config.headers ?? {};

      const opts:
        StreamableHTTPClientTransportOptions | SSEClientTransportOptions = {
        requestInit: { headers },
      };

      this.transport =
        config.transport === "sse"
          ? // eslint-disable-next-line @typescript-eslint/no-deprecated
            new SSEClientTransport(url, opts)
          : new StreamableHTTPClientTransport(url, opts);
    } else {
      throw new Error(
        `MCP server '${this.name}': needs either 'command' (stdio) or 'url' (http/sse)`,
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
    await this.client.connect(this.transport);

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

  async listTools(): Promise<MCPTool[]> {
    if (!this.client) {
      throw new Error(MCP_NOT_CONNECTED_ERROR);
    }
    const client = this.client;
    const tools: MCPTool[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await client.listTools(
        cursor !== undefined ? { cursor } : undefined,
      );
      tools.push(
        ...result.tools.map(
          ({
            name,
            description,
            _meta,
            inputSchema: { properties, ...rest },
          }) => ({
            name,
            description: description ?? "",
            inputSchema: { ...rest, properties: properties ?? {} },
            ...(_meta ? { _meta } : {}),
          }),
        ),
      );
      cursor = result.nextCursor;
      if (cursor !== undefined) {
        if (seenCursors.has(cursor)) {
          throw new Error(
            `MCP server '${this.name}' repeated tools cursor '${cursor}'`,
          );
        }
        seenCursors.add(cursor);
      }
    } while (cursor !== undefined);
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
    return tools.filter((tool) => {
      const ui = tool._meta?.ui;
      const visibility = isRecord(ui) ? ui.visibility : undefined;
      return !Array.isArray(visibility) || visibility.includes("model");
    });
  }

  getTool(name: string): MCPTool | undefined {
    return this.tools.get(name);
  }

  async readResource(uri: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.client) {
      throw new Error(MCP_NOT_CONNECTED_ERROR);
    }
    return this.client.readResource({ uri }, { signal });
  }

  async callToolResult(
    name: string,
    args: Record<string, unknown>,
    abortSignal?: AbortSignal,
  ): Promise<CallToolResult> {
    abortSignal?.throwIfAborted();
    if (!this.client) {
      throw new Error(MCP_NOT_CONNECTED_ERROR);
    }
    return CallToolResultSchema.parse(
      await this.client.callTool(
        { name, arguments: args },
        CallToolResultSchema,
        { signal: abortSignal },
      ),
    );
  }

  /** Calls a tool and preserves both its text fallback and provider-native rich content. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    abortSignal?: AbortSignal,
  ): Promise<ToolResult> {
    const result = await this.callToolResult(name, args, abortSignal);
    const converted = await mcpContentToToolOutput(result.content);
    const ui = this.tools.get(name)?._meta?.ui;
    const resourceUri = isRecord(ui) ? ui.resourceUri : undefined;
    return {
      ...converted,
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
    } catch (err) {
      log.error({ err }, "mcp operation failed");
    }
    if (!clientClosed && transport) {
      try {
        await transport.close();
      } catch (err) {
        log.error({ err }, "mcp transport close failed");
      }
    }
  }
}
