import { IncomingMessage, ServerResponse } from "node:http";

import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { fromNodeHandler, H3, serve } from "h3";

import { createServer } from "./server.js";
import { logger } from "./shared/logger.js";

export interface HttpServerHandle {
  readonly url: string;
  close(): Promise<void>;
}

export async function startHttpServer(
  host: string,
  port: number,
): Promise<HttpServerHandle> {
  const app = new H3();

  app.post("/mcp", async (event) => {
    const server = createServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
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
            void server.close().catch(() => {});
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
    silent: true,
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
      for (const transport of sseTransports.values()) {
        try {
          await transport.close();
        } catch {}
      }
      sseTransports.clear();
      await server.close(true);
    },
  };
}
