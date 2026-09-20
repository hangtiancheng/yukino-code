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

import { bodyParser } from "@koa/bodyparser";
import Router from "@koa/router";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Koa from "koa";

import { createServer } from "./server.js";
import { logger } from "./shared/logger.js";

export interface HttpServerHandle {
  /** Close SSE streams and all sockets; resolves when the listener is down. */
  close(): Promise<void>;
}

/**
 * HTTP transports host. Exposes both remote MCP transports on one port:
 * - Streamable HTTP:  POST /mcp        (stateless, JSON responses)
 * - legacy SSE:       GET /sse + POST /messages?sessionId=...
 * No authentication in this iteration: binds to localhost by default and is
 * intended for local / trusted networks only.
 */
export function startHttpServer(host: string, port: number): HttpServerHandle {
  const app = new Koa();
  const router = new Router();

  // Stateless Streamable HTTP: a fresh McpServer + transport per request.
  // Tool-module state lives in process-wide singletons, so instances are cheap
  // and no session bookkeeping is needed.
  router.post("/mcp", async (ctx) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    // The SDK writes the response directly to the raw socket.
    ctx.respond = false;
    ctx.res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(ctx.req, ctx.res, ctx.request.body);
  });

  router.get("/mcp", (ctx) => {
    // Stateless mode has no server-initiated notification stream.
    ctx.status = 405;
    ctx.body = { error: "Method Not Allowed" };
  });

  // Legacy SSE: one long-lived transport per GET /sse connection, messages
  // posted back on /messages correlated by sessionId.
  const sseTransports = new Map<string, SSEServerTransport>();

  router.get("/sse", async (ctx) => {
    ctx.respond = false;
    const transport = new SSEServerTransport("/messages", ctx.res);
    sseTransports.set(transport.sessionId, transport);
    const server = createServer();
    ctx.res.on("close", () => {
      sseTransports.delete(transport.sessionId);
      void server.close().catch(() => {
        // The response stream is already gone; nothing left to clean up.
      });
    });
    await server.connect(transport);
  });

  router.post("/messages", async (ctx) => {
    const sessionId = ctx.query["sessionId"];
    const transport = typeof sessionId === "string" ? sseTransports.get(sessionId) : undefined;
    if (!transport) {
      ctx.status = 400;
      ctx.body = { error: "Unknown session" };
      return;
    }
    ctx.respond = false;
    await transport.handlePostMessage(ctx.req, ctx.res, ctx.request.body);
  });

  app.on("error", (err: unknown) => {
    logger.warn({ err }, "http server error");
  });
  app.use(bodyParser());
  app.use(router.routes());
  app.use(router.allowedMethods());

  const server = app.listen(port, host, () => {
    logger.info(
      { host, port, streamableHttp: "POST /mcp", sse: "GET /sse, POST /messages?sessionId=..." },
      "MCP HTTP server listening",
    );
  });

  return {
    async close(): Promise<void> {
      // Long-lived SSE responses would keep server.close() waiting forever;
      // shut the transports first, then drop any remaining sockets.
      for (const transport of sseTransports.values()) {
        try {
          await transport.close();
        } catch {
          // Best-effort: the stream may already be gone.
        }
      }
      sseTransports.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
