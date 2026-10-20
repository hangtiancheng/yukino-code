import type { MCPServerConfig } from "@/config/index.js";
import { createChildLogger } from "@/logger/index.js";
import { MCPClient } from "@/mcp/client.js";
import type { MCPTool } from "@/mcp/client.js";
import { asErrorString } from "@/utils/index.js";

const log = createChildLogger({ module: "mcp" });

export interface ConnectResult {
  tools: { serverName: string; tool: MCPTool }[];
  servers: string[];
  errors: { serverName: string; error: string }[];
  instructions: { serverName: string; text: string }[];
}

export class MCPManager {
  constructor(private readonly appsEnabled = false) {}
  private clients = new Map<string, MCPClient>();
  private operation = Promise.resolve();

  /** Serialize lifecycle changes so startup, retries, and `/mcp reload` cannot race. */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.operation.then(fn, fn);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Brings up every configured server that has no live connection yet and reports what
   * this pass added. Servers already connected are left untouched, so calling it again
   * retries only the ones that failed — a server that was down earlier can join later
   * without disturbing the working ones.
   */
  async connectAll(configs: MCPServerConfig[]): Promise<ConnectResult> {
    return this.runExclusive(() => this.connectAllNow(configs));
  }

  /**
   * Drops every live connection, then brings up the given config from scratch. This is
   * what `/mcp reload` does: no diffing against the previous config, just a full
   * teardown followed by a full connect.
   */
  async reconnectAll(configs: MCPServerConfig[]): Promise<ConnectResult> {
    return this.runExclusive(async () => {
      await this.disconnectAllNow();
      return this.connectAllNow(configs);
    });
  }

  private async connectAllNow(
    configs: MCPServerConfig[],
  ): Promise<ConnectResult> {
    const result: ConnectResult = {
      tools: [],
      servers: [],
      errors: [],
      instructions: [],
    };

    const pending = [
      ...new Map(configs.map((cfg) => [cfg.name, cfg])).values(),
    ].filter((cfg) => cfg.enabled !== false && !this.clients.has(cfg.name));
    const connections = await Promise.all(
      pending.map(async (cfg) => {
        const client = new MCPClient(cfg, this.appsEnabled);
        try {
          await client.connect();
          const tools = await client.listTools();
          return { ok: true as const, cfg, client, tools };
        } catch (err) {
          log.error({ err }, "mcp operation failed");
          await client.disconnect();
          return { ok: false as const, cfg, error: asErrorString(err) };
        }
      }),
    );

    for (const connection of connections) {
      const { cfg } = connection;
      if (!connection.ok) {
        result.errors.push({ serverName: cfg.name, error: connection.error });
        continue;
      }
      const { client, tools } = connection;
      this.clients.set(cfg.name, client);
      result.servers.push(cfg.name);
      result.tools.push(
        ...tools.map((tool) => ({ serverName: cfg.name, tool })),
      );
      const instructions = client.getInstructions();
      if (instructions) {
        result.instructions.push({ serverName: cfg.name, text: instructions });
      }
    }

    return result;
  }

  private async disconnectAllNow(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.disconnect();
    }
    this.clients.clear();
  }

  getClient(name: string): MCPClient | undefined {
    return this.clients.get(name);
  }

  /** Every server with a live connection, across all connect passes. */
  connectedServers(): string[] {
    return [...this.clients.keys()];
  }

  /** Instructions advertised by every currently connected server. */
  connectedInstructions(): { serverName: string; text: string }[] {
    const instructions: { serverName: string; text: string }[] = [];
    for (const [serverName, client] of this.clients) {
      const text = client.getInstructions();
      if (text) {
        instructions.push({ serverName, text });
      }
    }
    return instructions;
  }

  /** The configured servers that are still not connected. */
  missingServers(configs: MCPServerConfig[]): string[] {
    return configs
      .filter((cfg) => cfg.enabled !== false && !this.clients.has(cfg.name))
      .map((cfg) => cfg.name);
  }

  async disconnectAll(): Promise<void> {
    await this.runExclusive(() => this.disconnectAllNow());
  }
}
