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

// brew services stop redis
// brew services start redis-stack

import { createClient, type RedisClientType } from "redis";
import { z } from "zod";

import type { RedisConfig } from "../../shared/config.js";
import { logger } from "../../shared/logger.js";
import type { Embedder } from "./embedder.js";

// Fail fast instead of reconnecting forever: this server is a short-lived CLI
// companion, so an unreachable Redis should degrade the tool, not hang it.
const CONNECT_TIMEOUT_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 3;

export interface DocsContext {
  client: RedisClientType;
  embedder: Embedder;
  redis: RedisConfig;
}

/**
 * Key of the source -> content-hash meta hash used for incremental sync.
 * Derived from the index name (NOT the key prefix): keys under the RediSearch
 * PREFIX would be picked up by the indexer as broken documents.
 */
export function sourcesKey(redis: RedisConfig): string {
  return `${redis.indexName}:sources`;
}

export async function connectRedis(redis: RedisConfig): Promise<RedisClientType> {
  const client = createClient({
    url: redis.url,
    socket: {
      connectTimeout: CONNECT_TIMEOUT_MS,
      reconnectStrategy: (retries: number) =>
        retries >= MAX_RECONNECT_ATTEMPTS ? false : Math.min(retries * 100, 1000),
    },
  });
  client.on("error", (err: unknown) => {
    logger.warn({ err }, "redis client error");
  });
  await client.connect();
  return client;
}

export async function closeRedis(client: RedisClientType): Promise<void> {
  try {
    await client.close();
  } catch {
    // Closing a broken connection is best-effort.
  }
}

// zod v4 treats bare z.unknown() object fields as required, so every probe
// field must be .optional(): FT.INFO replies carry either lowercase (RESP3)
// or uppercase (RESP2) keys, never both.
const IndexAttributeSchema = z.looseObject({
  attribute: z.unknown().optional(),
  identifier: z.unknown().optional(),
  DIM: z.unknown().optional(),
  dim: z.unknown().optional(),
});

const IndexInfoSchema = z.looseObject({
  attributes: z.array(z.unknown()).default([]),
});

/** Extract the stored vector dimension from an FT.INFO reply, if readable. */
function readVectorDim(info: unknown): number | null {
  const parsed = IndexInfoSchema.safeParse(info);
  if (!parsed.success) {
    return null;
  }
  for (const entry of parsed.data.attributes) {
    const attr = IndexAttributeSchema.safeParse(entry);
    if (!attr.success) {
      continue;
    }
    const name = attr.data.attribute ?? attr.data.identifier;
    if (name !== "vector") {
      continue;
    }
    const dim = Number(attr.data.DIM ?? attr.data.dim ?? Number.NaN);
    return Number.isFinite(dim) && dim > 0 ? dim : null;
  }
  return null;
}

/**
 * Probe the embedding provider for the real vector dimension and make the
 * index match it. The dimension is never taken from static config: the actual
 * model output is authoritative — a mismatch makes every HSET silently fail
 * RediSearch indexing (num_docs stays 0 while hash_indexing_failures climbs).
 */
export async function ensureIndex(ctx: DocsContext): Promise<void> {
  const dim = (await ctx.embedder.embedText("dimension probe")).length;

  let indexExists = false;
  try {
    const info: unknown = await ctx.client.ft.info(ctx.redis.indexName);
    indexExists = true;
    const storedDim = readVectorDim(info);
    if (storedDim !== null && storedDim !== dim) {
      logger.warn(
        { storedDim, dim },
        "index dimension mismatch, dropping and recreating the index",
      );
      await ctx.client.ft.dropIndex(ctx.redis.indexName);
      indexExists = false;
    }
  } catch {
    // Index doesn't exist yet.
  }

  if (indexExists) {
    return;
  }

  // Clean slate: wipe all hashes under the prefix before (re)creating the
  // index. Old vectors are useless after a dimension change, and RediSearch's
  // background rescan would otherwise resurrect them as duplicates that
  // source-based dedup can't see yet. Dropping the sources meta forces the
  // next sync to re-embed everything.
  for await (const keys of ctx.client.scanIterator({
    MATCH: `${ctx.redis.keyPrefix}*`,
    COUNT: 500,
  })) {
    if (keys.length > 0) {
      await ctx.client.del(keys);
    }
  }
  await ctx.client.del(sourcesKey(ctx.redis));

  await ctx.client.ft.create(
    ctx.redis.indexName,
    {
      vector: {
        type: "VECTOR",
        ALGORITHM: "HNSW",
        TYPE: "FLOAT32",
        DIM: dim,
        DISTANCE_METRIC: "COSINE",
      },
      content: { type: "TEXT" },
      _source: { type: "TAG" },
    },
    { ON: "HASH", PREFIX: ctx.redis.keyPrefix },
  );
  logger.info({ index: ctx.redis.indexName, dim }, "vector index created");
}
