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

// Note that because some servers are still using SSE, clients may need to support both transports during the migration period.

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

import type { MCPServerConfig } from "@/config/index.js";
import {
  asImageMediaType,
  maybeResizeAndDownsampleImage,
} from "@/images/index.js";
import { createChildLogger } from "@/logger/index.js";
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

// MCP image content uses {type:"image", data, mimeType}; providers use
// {type:"image", source:{type:"base64", media_type, data}}. Unsupported mime
// types stay in the text fallback as before.
const MCP_IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

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

  constructor(config: MCPServerConfig) {
    this.name = config.name;
    this.config = config;
  }

  /** Reconfigure a disconnected client while preserving wrapper references. */
  configure(config: MCPServerConfig): void {
    if (this.client || this.transport) {
      throw new Error(
        `MCP server '${this.name}' must be disconnected before reconfiguration`,
      );
    }
    this.name = config.name;
    this.config = config;
  }

  async connect(): Promise<void> {
    const config = expandMcpServerConfigEnvironment(this.config);
    if (config.command) {
      // stdio transport
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
      // http / sse transport

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

    this.client = new Client({ name: "yukino", version }, {});
    await this.client.connect(this.transport);
  }

  // The server's instructions from the initialize result, if any.
  getInstructions(): string {
    return this.client?.getInstructions() ?? "";
  }

  async listTools(): Promise<MCPTool[]> {
    if (!this.client) {
      throw new Error("Not connected");
    }
    const result = await this.client.listTools();
    return result.tools.map(
      ({
        name,
        description,
        inputSchema: { properties, ...inputSchemaRest },
      }) => ({
        name,
        description: description ?? "",
        inputSchema: { ...inputSchemaRest, properties: properties ?? {} },
      }),
    );
  }

  /** Calls a tool and preserves both its text fallback and provider-native rich content. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    abortSignal?: AbortSignal,
  ): Promise<ToolResult> {
    abortSignal?.throwIfAborted();
    if (!this.client) {
      throw new Error("Not connected");
    }
    const result = await this.client.callTool(
      { name, arguments: args },
      undefined,
      {
        signal: abortSignal,
      },
    );
    const converted =
      result.content && Array.isArray(result.content)
        ? await mcpContentToToolOutput(result.content)
        : { output: JSON.stringify(result) };
    return { ...converted, isError: result.isError === true };
  }

  async disconnect(): Promise<void> {
    try {
      await this.client?.close();
    } catch (err) {
      log.error({ err }, "mcp operation failed");
      // ignore
    }
    this.client = null;
    this.transport = null;
  }
}
