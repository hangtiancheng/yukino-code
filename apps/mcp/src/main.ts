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
import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { startHttpServer } from "./http.js";
import { createServer } from "./server.js";
import { loadConfig } from "./shared/config.js";
import { logger } from "./shared/logger.js";
import { modules } from "./tools/index.js";

let shuttingDown = false;

/** Close transports and tool modules, then exit. Never runs twice. */
function shutdown(reason: string, closeTransport: () => Promise<void>): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ reason }, "shutting down");
  // Safety net: a wedged transport/module must never keep the process alive.
  setTimeout(() => {
    process.exit(0);
  }, 5000).unref();
  void (async () => {
    try {
      await closeTransport();
    } catch (err) {
      logger.warn({ err }, "transport close failed");
    }
    for (const module of modules) {
      try {
        await module.shutdown?.();
      } catch (err) {
        logger.warn({ err, module: module.name }, "module shutdown failed");
      }
    }
    process.exit(0);
  })();
}

function registerSignalHandlers(closeTransport: () => Promise<void>): void {
  process.on("SIGINT", () => {
    shutdown("SIGINT", closeTransport);
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM", closeTransport);
  });
}

async function main(): Promise<void> {
  const useHttp = process.argv.includes("--http") || process.env["MCP_TRANSPORT"] === "http";

  if (useHttp) {
    const { host, port } = loadConfig();
    const httpServer = startHttpServer(host, port);
    registerSignalHandlers(() => httpServer.close());
  } else {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // When the client disconnects, open handles like the Redis connection
    // would keep the process alive — exit through shutdown instead. The SDK
    // transport does not self-close on stdin EOF, so watch stdin directly.
    server.server.onclose = () => {
      shutdown("transport closed", () => Promise.resolve());
    };
    process.stdin.on("end", () => {
      shutdown("stdin closed", () => server.close());
    });
    process.stdin.on("close", () => {
      shutdown("stdin closed", () => server.close());
    });
    registerSignalHandlers(() => server.close());
    logger.info("MCP stdio server connected");
  }

  // Kick off module initialization only after the transport is up, so tools
  // are listable immediately; tool calls await the same init internally.
  for (const module of modules) {
    if (module.init) {
      void module.init().catch((err: unknown) => {
        logger.warn({ err, module: module.name }, "module init failed");
      });
    }
  }
}

void main().catch((err: unknown) => {
  logger.error({ err }, "fatal error during startup");
  process.exit(1);
});
