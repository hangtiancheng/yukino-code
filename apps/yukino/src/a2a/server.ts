import { createServer } from "node:http";
import type { Server } from "node:http";

import {
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
  InMemoryTaskStore,
} from "@a2a-js/sdk/server";
import {
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
  UserBuilder,
} from "@a2a-js/sdk/server/express";
import express from "express";

import { buildAgentCard } from "./card.js";
import {
  createA2aRuntime,
  YukinoA2aExecutor,
  type A2aRuntimeFactory,
} from "./executor.js";

import { parseRemoteAddress } from "@/remote/address.js";

const A2A_DEFAULT_PORT = 18890;
const DEFAULT_ADDRESS = `127.0.0.1:${String(A2A_DEFAULT_PORT)}`;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export interface A2aServerHandle {
  /** Base URL of the running server, e.g. `http://127.0.0.1:18890/`. */
  url: string;
  /** URL of the agent card endpoint. */
  cardUrl: string;
  close(): Promise<void>;
}

export function parseA2aAddress(address?: string): {
  host: string;
  port: number;
} {
  const parsed = parseRemoteAddress(address ?? DEFAULT_ADDRESS, {
    defaultPort: A2A_DEFAULT_PORT,
    allowEphemeral: true,
  });
  if (!LOOPBACK_HOSTS.has(parsed.host)) {
    throw new Error("A2A server must listen on a loopback address.");
  }
  return parsed;
}

export interface StartA2aServerOptions {
  address?: string;
  runtimeFactory?: A2aRuntimeFactory;
  cwd?: string;
}

/**
 * Starts the A2A HTTP server: the agent card at
 * `/.well-known/agent-card.json`, JSON-RPC at `POST /`, and HTTP+JSON/REST
 * under `/v1/...`. Binds first, then rewrites the card URLs with the actual
 * port so port-0 (ephemeral) bindings advertise a reachable address.
 */
export async function startA2aServer(
  options: StartA2aServerOptions = {},
): Promise<A2aServerHandle> {
  const { host, port } = parseA2aAddress(options.address);
  const httpServer = createServer();
  await listen(httpServer, port, host);

  const bound = httpServer.address();
  if (!bound || typeof bound === "string") {
    throw new Error("A2A server did not bind to a TCP address.");
  }
  const displayHost =
    bound.family === "IPv6" ? `[${bound.address}]` : bound.address;
  const url = `http://${displayHost}:${String(bound.port)}/`;

  const card = buildAgentCard(url);
  const executor = new YukinoA2aExecutor(
    options.runtimeFactory ?? createA2aRuntime,
    options.cwd ?? process.cwd(),
  );
  const requestHandler = new DefaultRequestHandler(
    card,
    new InMemoryTaskStore(),
    executor,
    new DefaultExecutionEventBusManager(),
  );

  const app = express();
  app.use(
    "/.well-known/agent-card.json",
    agentCardHandler({
      agentCardProvider: requestHandler,
      legacyCompat: { enabled: true },
    }),
  );
  app.use(
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
      legacyCompat: { enabled: true },
    }),
  );
  app.use(
    restHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
      legacyCompat: { enabled: true },
    }),
  );
  httpServer.on("request", app);

  let closed = false;
  return {
    url,
    cardUrl: `${url}.well-known/agent-card.json`,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      httpServer.closeIdleConnections();
      await closeServer(httpServer);
      await executor.dispose();
    },
  };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
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

/** Starts the server and blocks until SIGINT/SIGTERM (CLI entry). */
export async function runA2aServer(address?: string): Promise<void> {
  const server = await startA2aServer({ address });
  process.stderr.write(`A2A server listening at ${server.url}\n`);
  process.stderr.write(`Agent card at ${server.cardUrl}\n`);

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
