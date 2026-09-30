import { IncomingMessage, ServerResponse } from "node:http";

import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { fromNodeHandler, H3, serve } from "h3";

import { createServer } from "./server.js";
import { logger } from "./shared/logger.js";

export interface HttpServerHandle {
  /** Resolved base URL of the listener (the port differs when binding 0). */
  readonly url: string;
  /** Close SSE streams and all sockets; resolves when the listener is down. */
  close(): Promise<void>;
}

/**
 * HTTP transports host. Exposes both remote MCP transports on one port:
 * - Streamable HTTP:  POST /mcp        (stateless, JSON responses)
 * - legacy SSE:       GET /sse + POST /messages?sessionId=...
 * GET /mcp answers 405: stateless mode has no server-initiated notification
 * stream. Requests are unauthenticated: the listener binds to localhost by
 * default and is intended for local / trusted networks only.
 */
export async function startHttpServer(
  host: string,
  port: number,
): Promise<HttpServerHandle> {
  const app = new H3();

  // Stateless Streamable HTTP: a fresh McpServer + transport per request.
  // Tool-module state lives in process-wide singletons, so instances are
  // cheap and no session bookkeeping is needed. The web-standard transport
  // consumes h3's Web Request directly and returns a Web Response.
  app.post("/mcp", async (event) => {
    const server = createServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      // No session id generator: stateless mode, one session per request.
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      // enableJsonResponse: response bodies are fully materialized JSON, so
      // closing the per-request pair right away is safe.
      return await transport.handleRequest(event.req);
    } finally {
      await transport.close();
      await server.close();
    }
  });

  app.get(
    "/mcp",
    () =>
      new Response(JSON.stringify({ error: "Method Not Allowed" }), {
        status: 405,
        headers: { "content-type": "application/json" },
      }),
  );

  // Legacy SSE: one long-lived transport per GET /sse connection, messages
  // posted back on /messages correlated by sessionId. The SDK's SSE
  // transport writes straight to the raw Node response.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const sseTransports = new Map<string, SSEServerTransport>();

  app.get(
    "/sse",
    fromNodeHandler(
      (req, res) =>
        new Promise<void>((resolve, reject) => {
          if (
            !(req instanceof IncomingMessage) ||
            !(res instanceof ServerResponse)
          ) {
            reject(new Error("the SSE transport requires the Node.js runtime"));
            return;
          }
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          const transport = new SSEServerTransport("/messages", res);
          sseTransports.set(transport.sessionId, transport);
          const server = createServer();
          res.once("close", () => {
            sseTransports.delete(transport.sessionId);
            void server.close().catch(() => {
              // The response stream is already gone; nothing left to clean up.
            });
            // Keep the handler pending until the stream closes: h3 ends the
            // raw response as soon as this promise resolves, which would
            // otherwise cut the SSE stream short.
            resolve();
          });
          server.connect(transport).catch((err: unknown) => {
            reject(err instanceof Error ? err : new Error(String(err)));
          });
        }),
    ),
  );

  app.post(
    "/messages",
    fromNodeHandler(async (req, res) => {
      if (
        !(req instanceof IncomingMessage) ||
        !(res instanceof ServerResponse)
      ) {
        throw new Error("the SSE transport requires the Node.js runtime");
      }
      const sessionId = new URL(
        req.url ?? "/",
        "http://internal.invalid",
      ).searchParams.get("sessionId");
      const transport =
        sessionId === null ? undefined : sseTransports.get(sessionId);
      if (transport === undefined) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Unknown session" }));
        return;
      }
      await transport.handlePostMessage(req, res);
    }),
  );

  const server = serve(app, {
    hostname: host,
    port,
    // pino owns logging (stderr JSON); srvx must not print to stdout.
    silent: true,
    // main.ts orchestrates SIGINT/SIGTERM shutdown (transports + modules);
    // srvx's own signal handlers would race it.
    gracefulShutdown: false,
  });
  await server.ready();
  const url = server.url ?? `http://${host}:${String(port)}/`;
  logger.info(
    {
      host,
      port,
      streamableHttp: "POST /mcp",
      sse: "GET /sse, POST /messages?sessionId=...",
    },
    "MCP HTTP server listening",
  );

  return {
    url,
    async close(): Promise<void> {
      // Long-lived SSE responses would keep the listener close waiting
      // forever; shut the transports first, then drop any remaining sockets.
      for (const transport of sseTransports.values()) {
        try {
          await transport.close();
        } catch {
          // Best-effort: the stream may already be gone.
        }
      }
      sseTransports.clear();
      await server.close(true);
    },
  };
}
