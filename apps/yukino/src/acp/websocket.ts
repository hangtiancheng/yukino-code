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

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { createNodeWebSocketUpgradeHandler } from "@agentclientprotocol/sdk/experimental/node";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { WebSocketServer } from "ws";

import { createYukinoAcpApp } from "./agent.js";

import { parseRemoteAddress } from "@/remote/address.js";

const ACP_PATH = "/acp";
const DEFAULT_ADDRESS = "127.0.0.1:18889";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export interface AcpWebSocketServerHandle {
  url: string;
  close(): Promise<void>;
}

export function parseAcpWebSocketAddress(address?: string): {
  host: string;
  port: number;
} {
  const parsed = parseRemoteAddress(address ?? DEFAULT_ADDRESS);
  if (!LOOPBACK_HOSTS.has(parsed.host)) {
    throw new Error("ACP WebSocket must listen on a loopback address.");
  }
  return parsed;
}

export async function startAcpWebSocketServer(
  address?: string,
): Promise<AcpWebSocketServerHandle> {
  const { host, port } = parseAcpWebSocketAddress(address);
  const acpServer = new AcpServer({
    createAgent: () => createYukinoAcpApp().app,
  });
  const webSocketServer = new WebSocketServer({ noServer: true });
  const handleUpgrade = createNodeWebSocketUpgradeHandler(
    acpServer,
    webSocketServer,
  );
  const httpServer = createServer((_request, response) => {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not Found");
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== ACP_PATH) {
      socket.destroy();
      return;
    }
    handleUpgrade(request, socket, head);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      httpServer.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      httpServer.off("error", onError);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(port, host);
  });

  const bound = httpServer.address();
  if (!bound || typeof bound === "string") {
    throw new Error("ACP WebSocket server did not bind to a TCP address.");
  }
  const boundAddress: AddressInfo = bound;
  const displayHost =
    boundAddress.family === "IPv6"
      ? `[${boundAddress.address}]`
      : boundAddress.address;
  let closed = false;

  return {
    url: `ws://${displayHost}:${String(boundAddress.port)}${ACP_PATH}`,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await acpServer.close();
      await new Promise<void>((resolve, reject) => {
        webSocketServer.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}

export async function runAcpWebSocket(address?: string): Promise<void> {
  const server = await startAcpWebSocketServer(address);
  process.stderr.write(`ACP WebSocket listening at ${server.url}\n`);

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      void server.close().finally(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
