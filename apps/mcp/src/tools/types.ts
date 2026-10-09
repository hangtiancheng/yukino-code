import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * A self-contained tool module. `register` is called once per McpServer
 * instance (the HTTP transports create a server per session/request), while
 * `init`/`shutdown` manage process-wide singleton state (connections, caches).
 */
export interface ToolModule {
  /** Unique module name, used in logs. */
  name: string;
  register(server: McpServer): void;
  /** Kicked off after transport connect; tool calls await the same init. */
  init?(): Promise<void>;
  shutdown?(): Promise<void>;
}
