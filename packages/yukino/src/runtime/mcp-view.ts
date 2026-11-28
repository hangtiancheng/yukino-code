import type { MCPExposure } from "@/mcp/config.js";
import type { MCPManager } from "@/mcp/manager.js";
import { MCPToolWrapper } from "@/mcp/tool-wrapper.js";
import type { ToolRegistry } from "@/tools/registry.js";

/** Borrow connections, but give each runtime its own revocable tool-policy view. */
export function bindBorrowedMcpView(
  manager: MCPManager,
  registry: ToolRegistry,
): () => Promise<void> {
  const published = new Set<string>();
  let operation: Promise<void> = Promise.resolve();
  let closed = false;
  const refresh = (): Promise<void> => {
    operation = operation
      .catch(() => undefined)
      .then(async () => {
        if (closed) {
          return;
        }
        const generation = manager.generation;
        const wrappers: MCPToolWrapper[] = [];
        for (const server of manager.connectedServers()) {
          const client = manager.getClient(server);
          if (!client) {
            continue;
          }
          for (const tool of await client.listTools()) {
            const exposure: MCPExposure = manager.canInvoke(
              server,
              tool.name,
              "direct",
            )
              ? "direct"
              : manager.canInvoke(server, tool.name, "dispatch")
                ? "deferred"
                : manager.canInvoke(server, tool.name, "codemode")
                  ? "codemode"
                  : "hidden";
            wrappers.push(new MCPToolWrapper(client, server, tool, exposure));
          }
        }
        if (closed || generation !== manager.generation) {
          return;
        }
        for (const name of published) {
          registry.unregister(name);
        }
        published.clear();
        for (const wrapper of wrappers) {
          if (registry.get(wrapper.name)) {
            continue;
          }
          registry.registerBorrowed(wrapper);
          published.add(wrapper.name);
        }
      })
      .catch((error: unknown) => {
        if (!closed) {
          for (const name of published) {
            registry.unregister(name);
          }
          published.clear();
        }
        throw error;
      });
    return operation;
  };
  const unsubscribe = manager.subscribe(() => {
    registry.invalidate();
    void refresh().catch(() => undefined);
  });
  registry.addCleanup(async () => {
    closed = true;
    unsubscribe();
    await operation.catch(() => undefined);
  });
  return refresh;
}
