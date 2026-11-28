import { createChildLogger } from "@/logger/index.js";
import type { MCPClient, MCPTool } from "@/mcp/client.js";
import type { MCPExposure } from "@/mcp/config.js";
import { MCP_NAME_SEP, MCP_TOOL_PREFIX } from "@/mcp/constants.js";
import type { ToolInvocationEntry } from "@/mcp/policy.js";
import { validateAgainstSchema } from "@/tools/schema.js";
import type {
  MCPToolLike,
  ToolResult,
  ToolContext,
  ToolCategory,
  ToolSchema,
} from "@/tools/types.js";
import { isRecord } from "@/utils/record.js";

const log = createChildLogger({ module: "mcp" });

export function sanitizeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Common prefix for all tool names under a given server. Use this anywhere you filter
 * tools by server; assembling the string by hand would skip sanitization.
 */
export function mcpToolNamePrefix(serverName: string): string {
  return `${MCP_TOOL_PREFIX}${sanitizeSegment(serverName)}${MCP_NAME_SEP}`;
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

  readonly modelVisible: boolean;
  readonly appVisible: boolean;
  constructor(
    client: MCPClient,
    serverName: string,
    tool: MCPTool,
    readonly exposure: MCPExposure = "deferred",
    private available: () => boolean = () => true,
  ) {
    const ui = tool._meta?.ui;
    const visibility = isRecord(ui) ? ui.visibility : undefined;
    this.modelVisible =
      !Array.isArray(visibility) || visibility.includes("model");
    this.appVisible = !Array.isArray(visibility) || visibility.includes("app");
    this.deferred = exposure === "deferred";
    this.name = buildMcpToolName(serverName, tool.name);

    this.description = tool.description;
    this.originalName = tool.name;
    this.client = client;
    this.inputSchema = tool.inputSchema;
    this.mcpServerName = serverName;
  }

  isAvailable(): boolean {
    return this.available();
  }

  /** Original server-provided JSON schema. */
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

  async execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const validation = validateAgainstSchema(args, this.inputSchema);
    if (!validation.valid) {
      return {
        output: `Invalid MCP arguments: ${validation.errors.join("; ")}`,
        isError: true,
      };
    }
    try {
      const entry: ToolInvocationEntry = ctx.invocationEntry ?? "direct";
      return await this.client.callTool(
        this.originalName,
        args,
        ctx.abortSignal,
        entry,
      );
    } catch {
      log.error("mcp operation failed");
      return {
        output:
          "MCP tool error: operation failed; no automatic replay was attempted",
        isError: true,
      };
    }
  }
}
