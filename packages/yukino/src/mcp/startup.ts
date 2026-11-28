import type { MCPRequestOptions } from "@/mcp/client.js";
import type { MCPServerConfig } from "@/mcp/config.js";
import {
  connectRegisteredMCPServers,
  type ConnectResult,
  type MCPManager,
  type MCPSource,
} from "@/mcp/manager.js";
import type { ProjectContext, ProjectResourceHooks } from "@/project/types.js";

export async function initializeMCPServers(
  manager: MCPManager,
  globalSource: MCPSource | undefined,
  project: ProjectContext,
  servers: readonly MCPServerConfig[],
  options: MCPRequestOptions = {},
): Promise<ConnectResult["errors"]> {
  options.signal?.throwIfAborted();
  const owners = new Map<string, MCPSource>();
  const projectNames = new Set<string>();
  const pending = new Set<string>();
  let bootstrapping = true;
  const resources: ProjectResourceHooks = {
    registerMcpServer: async (server, registration) => {
      const source =
        owners.get(registration.owner) ??
        manager.createSource("project", registration.owner, project.cwd);
      owners.set(registration.owner, source);
      await manager.registerServer(server, source);
      projectNames.add(server.name);
      if (server.enabled === false) {
        return;
      }
      if (bootstrapping) {
        pending.add(server.name);
      } else {
        await manager.connect(server.name);
      }
    },
    unregisterMcpServer: async (name, owner) => {
      const source = owners.get(owner);
      if (source) {
        await manager.unregisterServer(name, source);
      }
      projectNames.delete(name);
      pending.delete(name);
    },
  };
  try {
    await project.registerMcpServers(resources);
    options.signal?.throwIfAborted();
    for (const server of servers) {
      if (
        !projectNames.has(server.name) &&
        server.enabled !== false &&
        globalSource
      ) {
        await manager.registerServer(server, globalSource);
        pending.add(server.name);
      }
    }
    await project.loadExtensions(resources);
    options.signal?.throwIfAborted();
    const diagnostics = await connectRegisteredMCPServers(
      manager,
      [...pending],
      options,
    );
    return diagnostics.map((diagnostic) => ({
      serverName: diagnostic.serverName,
      error: `${diagnostic.message} (${diagnostic.transport}/${diagnostic.phase}${diagnostic.code ? ` ${diagnostic.code}` : diagnostic.httpStatus ? ` HTTP ${String(diagnostic.httpStatus)}` : ""})`,
      diagnostic,
    }));
  } finally {
    bootstrapping = false;
  }
}
