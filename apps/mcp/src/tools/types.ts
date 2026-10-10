import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface ToolModule {
  name: string;
  register(server: McpServer): void;
  init?(): Promise<void>;
  shutdown?(): Promise<void>;
}
