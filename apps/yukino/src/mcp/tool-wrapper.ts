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

import type { MCPClient, MCPTool } from "./client.js";

import { createChildLogger } from "@/logger/index.js";
import type {
  MCPToolLike,
  ToolResult,
  ToolContext,
  ToolCategory,
  ToolSchema,
} from "@/tools/types.js";
import { asErrorString } from "@/utils/index.js";

const log = createChildLogger({ module: "mcp" });

/** Common prefix for MCP tool names. */
export const MCP_TOOL_PREFIX = "mcp__";
/**
 * Separator between the server segment and the tool segment in a tool name. A double
 * underscore keeps the boundary reversible — server names and tool names may themselves
 * contain single underscores.
 */
export const MCP_NAME_SEP = "__";

/**
 * Replaces illegal characters with underscores so the composed tool name passes API validation.
 *
 * Hyphens are technically allowed by the API but are replaced here too: the Go and Python
 * implementations do the same. The same mcp_servers config must produce the same tool name
 * across all four languages, otherwise the same permissions.yaml would stop matching when
 * the language changes.
 */
export function sanitizeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Common prefix for all tool names under a given server. Use this anywhere you filter
 * tools by server; assembling the string by hand would skip sanitization.
 */
export function mcpToolNamePrefix(serverName: string): string {
  return MCP_TOOL_PREFIX + sanitizeSegment(serverName) + MCP_NAME_SEP;
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  return mcpToolNamePrefix(serverName) + sanitizeSegment(toolName);
}

export class MCPToolWrapper implements MCPToolLike {
  name: string;
  description: string;
  category: ToolCategory = "command" as const;

  // MCP tools are lazily loaded by default to avoid cramming all schemas into the prompt

  deferred = true;
  mcpServerName: string;

  private client: MCPClient;
  private originalName: string;
  private inputSchema: ToolSchema["input_schema"];

  constructor(client: MCPClient, serverName: string, tool: MCPTool) {
    this.name = buildMcpToolName(serverName, tool.name);

    this.description = tool.description;
    this.originalName = tool.name;
    this.client = client;
    this.inputSchema = tool.inputSchema;
    this.mcpServerName = serverName;
  }

  /** Original JSON schema. McpCall's argument coercion walks it layer by layer. */
  mcpInputSchema(): Record<string, unknown> {
    return this.inputSchema ?? {};
  }

  /** In eager mode the defer flag is cleared so MCP tools go straight into tools[]. */
  setDeferLoading(on: boolean): void {
    this.deferred = on;
  }

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.inputSchema,
    };
  }

  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      return await this.client.callTool(this.originalName, args, ctx.abortSignal);
    } catch (err) {
      log.error({ err }, "mcp operation failed");
      return {
        output: `MCP tool error: ${asErrorString(err)}`,
        isError: true,
      };
    }
  }
}
