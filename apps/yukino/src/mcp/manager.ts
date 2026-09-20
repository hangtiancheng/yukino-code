/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { isDeepStrictEqual } from "node:util";

import { MCPClient } from "./client.js";
import type { MCPTool } from "./client.js";

import type { MCPServerConfig } from "@/config/index.js";
import { createChildLogger } from "@/logger/index.js";
import { asErrorString } from "@/utils/index.js";

const log = createChildLogger({ module: "mcp" });

export interface ConnectResult {
  tools: { serverName: string; tool: MCPTool }[];
  servers: string[];
  errors: { serverName: string; error: string }[];
  instructions: { serverName: string; text: string }[];
}

export interface ReconcileResult extends ConnectResult {
  added: string[];
  removed: string[];
  restarted: string[];
  unchanged: string[];
}

export class MCPManager {
  private clients = new Map<string, MCPClient>();
  private configs = new Map<string, MCPServerConfig>();
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

  private async connectAllNow(
    configs: MCPServerConfig[],
    reusable = new Map<string, MCPClient>(),
  ): Promise<ConnectResult> {
    const result: ConnectResult = {
      tools: [],
      servers: [],
      errors: [],
      instructions: [],
    };

    for (const cfg of configs) {
      if (this.clients.has(cfg.name)) {
        continue;
      }
      const client = reusable.get(cfg.name) ?? new MCPClient(cfg);
      try {
        if (reusable.has(cfg.name)) {
          client.configure(cfg);
        }
        await client.connect();
        const tools = await client.listTools();

        // Recorded only once the tool list is in hand: a server that cannot be
        // listed is of no use, and keeping it here would make it look connected
        // on the next pass.
        this.clients.set(cfg.name, client);
        this.configs.set(cfg.name, structuredClone(cfg));
        result.servers.push(cfg.name);
        for (const tool of tools) {
          result.tools.push({ serverName: cfg.name, tool });
        }

        const instructions = client.getInstructions();
        if (instructions) {
          result.instructions.push({
            serverName: cfg.name,
            text: instructions,
          });
        }
      } catch (err) {
        log.error({ err }, "mcp operation failed");
        result.errors.push({
          serverName: cfg.name,
          error: asErrorString(err),
        });
        await client.disconnect();
      }
    }

    return result;
  }

  /**
   * Applies a freshly loaded config without disturbing unchanged connections.
   * A same-named server whose transport settings changed is restarted.
   */
  async reconcile(configs: MCPServerConfig[]): Promise<ReconcileResult> {
    return this.runExclusive(async () => {
      const desired = new Map(configs.map((config) => [config.name, config]));
      const removed: string[] = [];
      const restarted: string[] = [];
      const unchanged: string[] = [];
      const reusable = new Map<string, MCPClient>();

      for (const [name, client] of [...this.clients]) {
        const next = desired.get(name);
        const current = this.configs.get(name);
        if (next && current && isDeepStrictEqual(current, next)) {
          unchanged.push(name);
          continue;
        }

        await client.disconnect();
        this.clients.delete(name);
        this.configs.delete(name);
        if (next) {
          restarted.push(name);
          reusable.set(name, client);
        } else {
          removed.push(name);
        }
      }

      const connected = await this.connectAllNow(configs, reusable);
      const restartedSet = new Set(restarted);
      return {
        ...connected,
        added: connected.servers.filter((name) => !restartedSet.has(name)),
        removed,
        restarted,
        unchanged,
      };
    });
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
      .filter((cfg) => !this.clients.has(cfg.name))
      .map((cfg) => cfg.name);
  }

  async disconnectAll(): Promise<void> {
    await this.runExclusive(async () => {
      for (const client of this.clients.values()) {
        await client.disconnect();
      }
      this.clients.clear();
      this.configs.clear();
    });
  }
}
