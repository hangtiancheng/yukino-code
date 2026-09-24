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

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadConfig } from "../../shared/config.js";
import { logger } from "../../shared/logger.js";
import type { ToolModule } from "../types.js";
import { createEmbedder } from "./embedder.js";
import { syncDocs } from "./pipeline.js";
import {
  closeRedis,
  connectRedis,
  ensureIndex,
  type DocsContext,
} from "./redis-client.js";
import { retrieve, type RetrievedDoc } from "./retriever.js";

type EngineState =
  | { status: "ready"; ctx: DocsContext }
  | { status: "degraded"; reason: string };

// Fast phase budget (connect + dimension probe + index check). Callers sit on
// the MCP client's 60s call timeout, so a hanging provider must degrade early.
const INIT_TIMEOUT_MS = 15_000;
// A degraded engine retries at most this often (Redis/provider may come back
// up mid-session without restarting the CLI).
const DEGRADED_RETRY_MS = 30_000;

// Process-wide engine singleton shared by every transport session.
let statePromise: Promise<EngineState> | null = null;
let settled: EngineState | null = null;
let lastDegradedAt = 0;

function getState(): Promise<EngineState> {
  if (
    settled?.status === "degraded" &&
    Date.now() - lastDegradedAt >= DEGRADED_RETRY_MS
  ) {
    statePromise = null;
    settled = null;
  }
  statePromise ??= initEngine().then((state) => {
    settled = state;
    if (state.status === "degraded") {
      lastDegradedAt = Date.now();
    }
    return state;
  });
  return statePromise;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${String(ms)}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Two-phase initialization, degrading (never throwing) on any failure:
 * - fast phase (awaited): config check, Redis connect, dimension probe +
 *   index ensure — after this queries can already run against existing data;
 * - background phase (fire-and-forget): incremental docs sync, so a large
 *   knowledge base never blocks the first tool call into the client timeout.
 */
async function initEngine(): Promise<EngineState> {
  const config = loadConfig();

  if (!config.embedding.ok) {
    const reason = `embedding provider is not configured (${config.embedding.reason})`;
    logger.warn({ reason }, "docs degraded");
    return { status: "degraded", reason };
  }
  const embedder = createEmbedder(config.embedding.config);

  let ctx: DocsContext;
  try {
    const client = await withTimeout(
      connectRedis(config.redis),
      INIT_TIMEOUT_MS,
      "redis connection",
    );
    ctx = { client, embedder, redis: config.redis };
  } catch (err) {
    const reason =
      `cannot connect to Redis at ${config.redis.url} ` +
      `(is Redis Stack running?): ${errorMessage(err)}`;
    logger.warn({ err }, "docs degraded: redis unreachable");
    return { status: "degraded", reason };
  }

  try {
    await withTimeout(
      ensureIndex(ctx),
      INIT_TIMEOUT_MS,
      "vector index initialization",
    );
  } catch (err) {
    await closeRedis(ctx.client);
    const reason =
      "failed to initialize the vector index (check the embedding endpoint/API key " +
      `and that Redis has the RediSearch module): ${errorMessage(err)}`;
    logger.warn({ err }, "docs degraded: index initialization failed");
    return { status: "degraded", reason };
  }

  void syncDocs(ctx, config.docsDir).catch((err: unknown) => {
    logger.warn({ err }, "background docs sync failed");
  });

  logger.info("docs ready (docs sync continues in the background)");
  return { status: "ready", ctx };
}

function formatResults(docs: RetrievedDoc[]): string {
  return docs
    .map((doc, i) => {
      const rawTitle = doc.metadata["title"];
      const title =
        typeof rawTitle === "string" && rawTitle !== ""
          ? rawTitle
          : "(untitled)";
      const rawSource = doc.metadata["_source"];
      const source = typeof rawSource === "string" ? rawSource : "(unknown)";
      const header = `[${String(i + 1)}] source: ${source} | title: ${title} | score: ${doc.score.toFixed(3)}`;
      return `${header}\n${doc.content}`;
    })
    .join("\n\n---\n\n");
}

const InputSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      "Natural-language question or keywords to search the knowledge base with.",
    ),
  top_k: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(3)
    .describe("Number of most relevant chunks to return (1-10, default 3)."),
};

export const docsModule: ToolModule = {
  name: "docs",

  register(server: McpServer): void {
    const docsDir = loadConfig().docsDir;
    server.registerTool(
      "docs",
      {
        title: "Search Docs",
        description:
          "Semantic search (embedding-based RAG) over the local Yukino knowledge base " +
          `built from Markdown/text documents in ${docsDir}. ` +
          "Use it to look up project- or team-specific knowledge, internal guides and notes. " +
          "Returns the most relevant document chunks with their source file, section title " +
          "and similarity score.",
        inputSchema: InputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ query, top_k }) => {
        const state = await getState();
        if (state.status === "degraded") {
          return {
            content: [
              { type: "text", text: `docs is unavailable: ${state.reason}` },
            ],
            isError: true,
          };
        }
        try {
          const docs = await retrieve(state.ctx, query, top_k);
          if (docs.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No matching documents in the knowledge base.",
                },
              ],
            };
          }
          return { content: [{ type: "text", text: formatResults(docs) }] };
        } catch (err) {
          logger.warn({ err }, "docs query failed");
          // The Redis client's reconnect strategy gives up quickly by design,
          // so a dropped connection never self-heals. Mark the engine degraded
          // (cached, so the retry-window backoff still applies) to let a later
          // call re-initialize it from scratch.
          if (!state.ctx.client.isOpen) {
            const degraded: EngineState = {
              status: "degraded",
              reason: `redis connection lost: ${errorMessage(err)}`,
            };
            settled = degraded;
            statePromise = Promise.resolve(degraded);
            lastDegradedAt = Date.now();
            void closeRedis(state.ctx.client);
          }
          return {
            content: [
              { type: "text", text: `docs failed: ${errorMessage(err)}` },
            ],
            isError: true,
          };
        }
      },
    );
  },

  async init(): Promise<void> {
    await getState();
  },

  async shutdown(): Promise<void> {
    // Never wait for an in-flight init/sync (the CLI client force-kills after
    // ~4s); only close what is already connected. In-flight work dies with
    // the process.
    if (settled?.status === "ready") {
      await closeRedis(settled.ctx.client);
    }
  },
};
