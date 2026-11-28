import { z } from "zod";

import { MCP_NAME_SEP, MCP_TOOL_PREFIX } from "@/mcp/constants.js";
import { buildMcpToolName, sanitizeSegment } from "@/mcp/tool-wrapper.js";
import {
  MCP_CALL_ARGUMENTS_REQUIRED,
  MCP_CALL_TOOL_REQUIRED,
} from "@/tools/constants.js";
import {
  MCP_CALL_ARGUMENTS_DESCRIPTION,
  MCP_CALL_DESCRIPTION,
  MCP_CALL_SERVER_DESCRIPTION,
  MCP_CALL_TOOL_DESCRIPTION,
} from "@/tools/prompts.js";
import type { ToolRegistry } from "@/tools/registry.js";
import { validateAgainstSchema } from "@/tools/schema.js";
import type {
  Tool,
  MCPToolLike,
  ToolContext,
  ToolResult,
} from "@/tools/types.js";
import { ValidatedTool } from "@/tools/validated-tool.js";

/**
 * The content used for permission rule matching, normalized to server__tool.
 *
 * It carries no mcp__ prefix: McpCall(linear__create_issue).
 *
 * Both segments must go through sanitize. The model may pass a short name or a full
 * name; the segments in a full name are already processed by the wrapper, while a
 * short name is given by the model as-is. Without uniform handling, the same call
 * would yield different content for a short name vs. a full name, and rules would
 * fail to match.
 */
export function mcpCallPermissionContent(server: string, tool: string): string {
  if (tool.startsWith(MCP_TOOL_PREFIX)) {
    return tool.slice(MCP_TOOL_PREFIX.length);
  }
  return sanitizeSegment(server) + MCP_NAME_SEP + sanitizeSegment(tool);
}

export function isMcpToolLike(tool: Tool): tool is MCPToolLike {
  return "mcpInputSchema" in tool && typeof tool.mcpInputSchema === "function";
}

const McpCallToolInputSchema = z.strictObject({
  server: z.string().describe(MCP_CALL_SERVER_DESCRIPTION),
  tool: z.string().describe(MCP_CALL_TOOL_DESCRIPTION),
  arguments: z
    .record(z.string(), z.json())
    .describe(MCP_CALL_ARGUMENTS_DESCRIPTION),
});

export class McpCallTool extends ValidatedTool<
  z.output<typeof McpCallToolInputSchema>
> {
  name = "McpCall";
  description = MCP_CALL_DESCRIPTION;
  category = "command" as const;
  // This tool must stay in tools[] itself, otherwise the model has no entry point
  deferred = false;

  constructor(private registry: ToolRegistry) {
    super();
  }

  parameters() {
    return McpCallToolInputSchema;
  }

  resolveTarget(args: Record<string, unknown>): MCPToolLike | undefined {
    const input = this.parameters().safeParse(args);
    if (!input.success) {
      return undefined;
    }
    const { server, tool: name } = input.data;
    if (!server || !name) {
      return undefined;
    }
    const fullName = name.startsWith(MCP_TOOL_PREFIX)
      ? name
      : buildMcpToolName(server, name);
    const target = this.registry.get(fullName);
    // The routed server must be the one that permission rules evaluated.
    return target &&
      this.registry.canInvoke(fullName, "dispatch") &&
      isMcpToolLike(target) &&
      target.mcpServerName === server
      ? target
      : undefined;
  }

  private availableNames(): string[] {
    return this.registry
      .listTools()
      .filter(
        (t) =>
          t.name.startsWith(MCP_TOOL_PREFIX) &&
          this.registry.canInvoke(t.name, "dispatch"),
      )
      .map((t) => t.name)
      .sort();
  }

  protected async executeValidated(
    ctx: ToolContext,
    args: z.output<typeof McpCallToolInputSchema>,
  ): Promise<ToolResult> {
    const server = args.server ?? "";
    const tool = args.tool ?? "";
    if (tool === "") {
      return { output: MCP_CALL_TOOL_REQUIRED, isError: true };
    }

    const target = this.resolveTarget(args);
    if (!target) {
      const names = this.availableNames();
      const hint = names.length > 0 ? names.join(", ") : "(none connected)";
      return {
        output: `Unknown MCP tool '${tool}' on server '${server}'. Available tools: ${hint}`,
        isError: true,
      };
    }

    if (
      typeof args.arguments !== "object" ||
      args.arguments === null ||
      Array.isArray(args.arguments)
    ) {
      return {
        output: MCP_CALL_ARGUMENTS_REQUIRED,
        isError: true,
      };
    }
    const inner = args.arguments;
    const validation = validateAgainstSchema(inner, target.mcpInputSchema());
    if (!validation.valid) {
      return {
        output: `Invalid MCP arguments: ${validation.errors.join("; ")}`,
        isError: true,
      };
    }

    ctx.abortSignal?.throwIfAborted();
    const authorization = this.registry.captureAuthorization(
      target.name,
      "dispatch",
    );
    if (!this.registry.validateAuthorization(authorization)) {
      return { output: "MCP tool authorization was revoked", isError: true };
    }
    const invocationContext = {
      ...ctx,
      invocationEntry: "dispatch",
    } satisfies ToolContext;
    return target.execute(invocationContext, inner);
  }
}
