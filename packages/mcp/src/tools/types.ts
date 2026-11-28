import type { McpServer } from "@modelcontextprotocol/server";

export interface ToolModule {
  name: string;
  register(server: McpServer): void;
  init?(): Promise<void>;
  shutdown?(): Promise<void>;
}
