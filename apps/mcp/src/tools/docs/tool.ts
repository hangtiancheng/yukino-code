import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadConfig } from "@/shared/config.js";
import { logger } from "@/shared/logger.js";
import { TOOL_NAMES } from "@/tools/names.js";
import type { ToolModule } from "@/tools/types.js";
import { createEmbedder } from "./embedder.js";
import { syncDocs, type SyncStats } from "./pipeline.js";
import {
  closeStore,
  ensureSchema,
  openStore,
  type DocsContext,
} from "./store.js";
import { retrieve, type RetrievedDoc } from "./retriever.js";

type EngineState =
  | { status: "ready"; ctx: DocsContext }
  | { status: "degraded"; reason: string };

// Fast phase budget (open + dimension probe + schema check). Callers sit on
// the MCP client's 60s call timeout, so a hanging provider must degrade early.
const INIT_TIMEOUT_MS = 15_000;
// A degraded engine retries at most this often (the embedding provider may come
// back up mid-session without restarting the CLI).
const DEGRADED_RETRY_MS = 30_000;

// Process-wide engine singleton shared by every transport session.
let syncPromise: Promise<SyncStats> | null = null;

function runSync(ctx: DocsContext): Promise<SyncStats> {
  syncPromise ??= syncDocs(ctx, loadConfig().docsDir).finally(() => {
    syncPromise = null;
  });
  return syncPromise;
}

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
 * - fast phase (awaited): config check, index open, dimension probe +
 *   schema ensure — after this queries can already run against existing data;
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
    ctx = {
      db: openStore(config.index),
      embedder,
      index: config.index,
      cache: null,
    };
  } catch (err) {
    const reason =
      `cannot open the vector index at ${config.index.dbPath}: ` +
      `${errorMessage(err)}`;
    logger.warn({ err }, "docs degraded: index unreachable");
    return { status: "degraded", reason };
  }

  try {
    await withTimeout(
      ensureSchema(ctx),
      INIT_TIMEOUT_MS,
      "vector index initialization",
    );
  } catch (err) {
    closeStore(ctx.db);
    const reason =
      "failed to initialize the vector index (check the embedding endpoint/API key " +
      `and that ${config.index.dbPath} is writable): ${errorMessage(err)}`;
    logger.warn({ err }, "docs degraded: index initialization failed");
    return { status: "degraded", reason };
  }

  void runSync(ctx).catch((err: unknown) => {
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
      TOOL_NAMES.docsSync,
      {
        title: "Sync Docs",
        description:
          "Refresh the RAG knowledge base from the configured local docs directory. Waits for initial/in-flight indexing, adds/updates changed files and removes deleted files. Call after editing documents or when docs_tool reports indexing in progress. Per-file failures preserve the previous version and are reported in stats.",
        inputSchema: {},
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async () => {
        const state = await getState();
        if (state.status === "degraded")
          return {
            content: [
              { type: "text", text: `docs is unavailable: ${state.reason}` },
            ],
            isError: true,
          };
        try {
          const stats = await runSync(state.ctx);
          return {
            content: [{ type: "text", text: JSON.stringify(stats) }],
            structuredContent: { ...stats },
            ...(stats.failed ? { isError: true } : {}),
          };
        } catch (err) {
          return {
            content: [
              { type: "text", text: `docs sync failed: ${errorMessage(err)}` },
            ],
            isError: true,
          };
        }
      },
    );
    server.registerTool(
      TOOL_NAMES.docsTool,
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
                  text: syncPromise
                    ? "Knowledge base indexing is still in progress. Call docs_sync to wait for it, then retry the search."
                    : "No matching documents in the knowledge base.",
                },
              ],
            };
          }
          return {
            content: [{ type: "text", text: formatResults(docs) }],
            structuredContent: {
              documents: docs,
              indexing: syncPromise !== null,
            },
          };
        } catch (err) {
          logger.warn({ err }, "docs query failed");
          // A closed database handle never self-heals, so mark the engine
          // degraded (cached, so the retry-window backoff still applies) to let
          // a later call re-initialize it from scratch.
          if (!state.ctx.db.isOpen) {
            const degraded: EngineState = {
              status: "degraded",
              reason: `vector index connection lost: ${errorMessage(err)}`,
            };
            settled = degraded;
            statePromise = Promise.resolve(degraded);
            lastDegradedAt = Date.now();
            closeStore(state.ctx.db);
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
      closeStore(settled.ctx.db);
    }
  },
};
