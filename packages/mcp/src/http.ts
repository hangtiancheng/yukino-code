import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { H3, serve } from "h3";

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
    },
    "MCP HTTP server listening",
  );

  return {
    url,
    async close(): Promise<void> {
      await server.close(true);
    },
  };
}
