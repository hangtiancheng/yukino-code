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

import type { ToolRegistry } from "./registry.js";
import {
  type Tool,
  type ToolCategory,
  type ToolContext,
  type ToolResult,
  type ToolResultContentBlock,
  type ToolSchema,
} from "./types.js";

import { MCP_TOOL_PREFIX } from "@/mcp/tool-wrapper.js";
import { intArg, strArg } from "@/utils/index.js";

export class ToolSearchTool implements Tool {
  name = "ToolSearch";

  description = "Search for and load deferred tools by name or keyword.";
  category: ToolCategory = "read";

  private registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  schema(): ToolSchema {
    const inputSchema = {
      type: "object" as const,
      properties: {
        query: {
          type: "string" as const,
          description:
            'Search query. Use "select:name1,name2" to load specific tools by name, or keywords to search.',
        },
        max_results: {
          type: "integer" as const,
          description: "Max results to return",
          default: 5,
        },
      },
      required: ["query"],
    };
    return {
      name: this.name,
      description: this.description,
      input_schema: inputSchema,
    };
  }

  execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const query = strArg(args, "query");
    const maxResults = intArg(args, "max_results", 5);

    if (!query) {
      return Promise.resolve({
        output: "Error: query is required",
        isError: true,
      });
    }
    const selection = query.startsWith("select:");
    const tools = selection
      ? this.registry.findDeferredByNames(
          query
            .slice("select:".length)
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean),
        )
      : this.registry.searchDeferred(
          query,
          Math.max(1, Math.min(maxResults, 50)),
        );
    if (tools.length === 0) {
      return Promise.resolve({
        output: "No deferred tools matched the query.",
        isError: false,
      });
    }

    const mcp = tools.filter((tool) => tool.name.startsWith(MCP_TOOL_PREFIX));
    const local = tools.filter(
      (tool) => !tool.name.startsWith(MCP_TOOL_PREFIX),
    );
    for (const tool of local) {
      this.registry.markDiscovered(tool.name);
    }
    const native = this.registry.mcpLoadingMode === "native";
    const schemas = (native ? local : tools).map((tool) =>
      JSON.stringify(tool.schema(), null, 2),
    );
    const routing =
      mcp.length === 0
        ? ""
        : this.registry.mcpLoadingMode === "dispatch"
          ? "\n\nInvoke MCP tools through McpCall with the server name, full tool name, and an arguments object matching the target input_schema, including JSON types."
          : "\n\nThese MCP tools can be called directly by their full names.";
    const output =
      [
        `Loaded ${String(tools.length)} tool(s): ${tools.map((tool) => tool.name).join(", ")}.`,
        ...schemas,
      ].join("\n\n") + routing;
    return Promise.resolve({
      output,
      isError: false,
      ...(native && mcp.length > 0
        ? {
            contentBlocks: [
              { type: "text", text: output },
              ...mcp.map((tool): ToolResultContentBlock => ({
                type: "tool_reference",
                tool_name: tool.name,
              })),
            ] satisfies ToolResultContentBlock[],
          }
        : {}),
    });
  }
}
