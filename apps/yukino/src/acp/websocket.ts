import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { createNodeWebSocketUpgradeHandler } from "@agentclientprotocol/sdk/experimental/node";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { WebSocketServer } from "ws";

import { createYukinoAcpApp } from "./agent.js";

import { parseRemoteAddress } from "@/remote/address.js";

const ACP_PATH = "/acp";
const ACP_WS_DEFAULT_PORT = 18889;
const DEFAULT_ADDRESS = `127.0.0.1:${String(ACP_WS_DEFAULT_PORT)}`;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export interface AcpWebSocketServerHandle {
  url: string;
  close(): Promise<void>;
}

export function parseAcpWebSocketAddress(address?: string): {
  host: string;
  port: number;
} {
  const parsed = parseRemoteAddress(address ?? DEFAULT_ADDRESS, {
    defaultPort: ACP_WS_DEFAULT_PORT,
    allowEphemeral: true,
  });
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
      // Close every server even when an earlier one rejects: bailing out at
      // the first failure (or guarding retries away with `closed`) would
      // leave the remaining listeners holding their ports. The first error
      // is rethrown once everything has been attempted.
      let firstError: Error | undefined;
      const record = (err: unknown): void => {
        firstError =
          firstError ?? (err instanceof Error ? err : new Error(String(err)));
      };
      try {
        await acpServer.close();
      } catch (err) {
        record(err);
      }
      try {
        await closeWithCallback(webSocketServer);
      } catch (err) {
        record(err);
      }
      try {
        await closeWithCallback(httpServer);
      } catch (err) {
        record(err);
      }
      if (firstError !== undefined) {
        throw firstError;
      }
    },
  };
}

/** Resolves when the server is closed; rejects with the close callback's error. */
function closeWithCallback(server: {
  close(callback: (error?: Error | null) => void): unknown;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export async function runAcpWebSocket(address?: string): Promise<void> {
  const server = await startAcpWebSocketServer(address);
  process.stderr.write(`ACP WebSocket listening at ${server.url}\n`);

  await new Promise<void>((resolve, reject) => {
    const shutdown = (): void => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      void server.close().then(resolve, reject);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
