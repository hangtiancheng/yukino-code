import { z } from "zod";

import { MCP_TOOL_PREFIX } from "@/mcp/constants.js";
import { QUERY_REQUIRED_ERROR } from "@/tools/constants.js";
import {
  TOOL_SEARCH_DESCRIPTION,
  TOOL_SEARCH_MAX_RESULTS_DESCRIPTION,
  TOOL_SEARCH_QUERY_DESCRIPTION,
} from "@/tools/prompts.js";
import type { ToolRegistry } from "@/tools/registry.js";
import {
  type ToolCategory,
  type ToolContext,
  type ToolResult,
  type ToolResultContentBlock,
} from "@/tools/types.js";
import { ValidatedTool } from "@/tools/validated-tool.js";

const ToolSearchToolInputSchema = z.strictObject({
  query: z.string().describe(TOOL_SEARCH_QUERY_DESCRIPTION),
  max_results: z
    .number()
    .int()
    .describe(TOOL_SEARCH_MAX_RESULTS_DESCRIPTION)
    .default(5),
});

export class ToolSearchTool extends ValidatedTool<
  z.output<typeof ToolSearchToolInputSchema>
> {
  name = "ToolSearch";

  description = TOOL_SEARCH_DESCRIPTION;
  category: ToolCategory = "read";

  private registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    super();
    this.registry = registry;
  }

  parameters() {
    return ToolSearchToolInputSchema;
  }

  protected executeValidated(
    _ctx: ToolContext,
    args: z.output<typeof ToolSearchToolInputSchema>,
  ): Promise<ToolResult> {
    const query = args.query ?? "";
    const maxResults = args.max_results ?? 5;

    if (!query) {
      return Promise.resolve({
        output: QUERY_REQUIRED_ERROR,
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
    const native = this.registry.mcpLoadingMode === "native";
    for (const tool of native ? tools : local) {
      this.registry.markDiscovered(tool.name);
    }
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
