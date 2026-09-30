import { createMcpSocketClient } from "./mcp-socket-client.js";
import { createMcpSocketPool } from "./mcp-socket-pool.js";
import type { YukinoForChromeContext, SocketClient } from "./types.js";

/**
 * Create the local socket client for the Chrome extension MCP server.
 * Transport choice: socket pool (multi-profile) > single socket.
 */
export function createChromeSocketClient(
  context: YukinoForChromeContext,
): SocketClient {
  return context.getSocketPaths
    ? createMcpSocketPool(context)
    : createMcpSocketClient(context);
}
