import { createServer } from "node:http";
import type { Server } from "node:http";

import {
  DefaultExecutionEventBusManager,
  InMemoryTaskStore,
} from "@a2a-js/sdk/server";
import {
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
  UserBuilder,
} from "@a2a-js/sdk/server/express";
import express from "express";
import type { ErrorRequestHandler, Request, Response } from "express";

import { buildAgentCard } from "@/a2a/card.js";
import {
  A2A_DEFAULT_PORT,
  AGENT_CARD_PATH,
  DEFAULT_ADDRESS,
  A2A_METHODS,
  A2A_PROTOCOL_VERSION,
  MALFORMED_JSON_ERROR,
  MISSING_VERSION_ERROR,
  REQUEST_BODY_LIMIT,
  REQUEST_TOO_LARGE_ERROR,
  unknownMethodError,
  unsupportedVersionError,
  LOOPBACK_REQUIRED_ERROR,
  SERVER_NOT_BOUND_ERROR,
} from "@/a2a/constants.js";
import {
  createA2aRuntime,
  YukinoA2aExecutor,
  type A2aRuntimeFactory,
} from "@/a2a/executor.js";
import { YukinoA2aRequestHandler } from "@/a2a/request-handler.js";
import { parseRemoteAddress } from "@/remote/address.js";
import { LOOPBACK_HOSTS } from "@/remote/constants.js";
import { isRecord } from "@/utils/index.js";

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
    throw new Error(LOOPBACK_REQUIRED_ERROR);
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
    throw new Error(SERVER_NOT_BOUND_ERROR);
  }
  const displayHost =
    bound.family === "IPv6" ? `[${bound.address}]` : bound.address;
  const url = `http://${displayHost}:${String(bound.port)}/`;

  const card = buildAgentCard(url);
  const executor = new YukinoA2aExecutor(
    options.runtimeFactory ?? createA2aRuntime,
    options.cwd ?? process.cwd(),
  );
  const requestHandler = new YukinoA2aRequestHandler(
    card,
    new InMemoryTaskStore(),
    executor,
    new DefaultExecutionEventBusManager(),
  );

  const app = express();
  app.use(
    AGENT_CARD_PATH,
    agentCardHandler({
      agentCardProvider: requestHandler,
    }),
  );
  app.use(
    express.json({
      limit: REQUEST_BODY_LIMIT,
      type: ["application/json", "application/a2a+json"],
      strict: false,
    }),
  );
  const parseErrorHandler: ErrorRequestHandler = (
    error: unknown,
    req,
    res,
    next,
  ) => {
    if (
      !isRecord(error) ||
      (error.type !== "entity.too.large" &&
        error.type !== "entity.parse.failed")
    ) {
      next(error);
      return;
    }
    const tooLarge = error.type === "entity.too.large";
    sendProtocolError(
      req,
      res,
      tooLarge ? 413 : 400,
      -32700,
      tooLarge ? REQUEST_TOO_LARGE_ERROR : MALFORMED_JSON_ERROR,
      tooLarge ? "CONTENT_TOO_LARGE" : "INVALID_ARGUMENT",
    );
  };
  app.use(parseErrorHandler);
  app.use((req, res, next) => {
    if (req.path !== "/" && !req.path.startsWith("/v1/")) {
      next();
      return;
    }
    const version = req.header("A2A-Version");
    if (version !== A2A_PROTOCOL_VERSION) {
      sendProtocolError(
        req,
        res,
        req.path === "/" ? 200 : 400,
        -32009,
        version ? unsupportedVersionError(version) : MISSING_VERSION_ERROR,
        "VERSION_NOT_SUPPORTED",
      );
      return;
    }
    const body: unknown = req.body;
    if (
      req.path === "/" &&
      isRecord(body) &&
      body.jsonrpc === "2.0" &&
      typeof body.method === "string" &&
      !A2A_METHODS.has(body.method)
    ) {
      sendProtocolError(
        req,
        res,
        200,
        -32601,
        unknownMethodError(body.method),
        "METHOD_NOT_FOUND",
      );
      return;
    }
    next();
  });
  app.use(
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );
  app.use(
    "/v1",
    restHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );
  httpServer.on("request", app);

  let closed = false;
  return {
    url,
    cardUrl: `${url}${AGENT_CARD_PATH.slice(1)}`,
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

function sendProtocolError(
  req: Request,
  res: Response,
  httpStatus: number,
  code: number,
  message: string,
  reason: string,
): void {
  const details = [
    {
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason,
      domain: "a2a-protocol.org",
    },
  ];
  const body: unknown = req.body;
  if (req.path === "/") {
    res.status(httpStatus).json({
      jsonrpc: "2.0",
      id: isRecord(body) ? (body.id ?? null) : null,
      error: { code, message, data: details },
    });
  } else {
    res.status(httpStatus).json({
      error: {
        code: httpStatus,
        message,
        status:
          reason === "VERSION_NOT_SUPPORTED"
            ? "FAILED_PRECONDITION"
            : "INVALID_ARGUMENT",
        details,
      },
    });
  }
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
