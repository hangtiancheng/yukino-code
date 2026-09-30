import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * A self-contained tool module. `register` is called once per McpServer
 * instance (the HTTP transports create a server per session/request), while
 * `init`/`shutdown` manage process-wide singleton state (connections, caches).
 */
export interface ToolModule {
  /** Unique module name, used in logs. */
  name: string;
  /** Register the module's tools on an MCP server instance. */
  register(server: McpServer): void;
  /** Optional background initialization kicked off after transport connect. */
  init?(): Promise<void>;
  /** Optional graceful shutdown. */
  shutdown?(): Promise<void>;
}
