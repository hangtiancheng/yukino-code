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

import { sourcesKey, type DocsContext } from "./redis-client.js";
import { escapeTagValue, float32ToBuffer } from "./utils.js";

export interface IndexChunk {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
}

// Cap stored content: Redis TEXT has no built-in limit and oversized chunks
// only bloat tool responses.
const MAX_CONTENT_LENGTH = 8192;

// Insert document chunks. hSet is idempotent (overwrites), so re-indexing the
// same id is safe. Uses MULTI/EXEC for atomic batch writes.
export async function indexChunks(ctx: DocsContext, chunks: IndexChunk[]): Promise<number> {
  if (chunks.length === 0) {
    return 0;
  }
  const vectors = await ctx.embedder.embedTexts(chunks.map((c) => c.content));

  const pipeline = ctx.client.multi();
  for (let i = 0; i < chunks.length; i++) {
    const key = `${ctx.redis.keyPrefix}${chunks[i].id}`;
    pipeline.hSet(key, {
      vector: float32ToBuffer(vectors[i]),
      content: chunks[i].content.slice(0, MAX_CONTENT_LENGTH),
      _source: String(chunks[i].metadata["_source"] ?? ""),
      metadata: JSON.stringify(chunks[i].metadata),
      created_at: new Date().toISOString(),
    });
  }
  await pipeline.exec();
  return chunks.length;
}

/** Thrown when another server instance holds the per-source delete lock. */
export class LockConflictError extends Error {
  constructor(source: string) {
    super(`another deletion is in progress for source "${source}"`);
    this.name = "LockConflictError";
  }
}

// Delete all chunks whose _source TAG matches `source`. Redis has no
// DELETE-WHERE, so search-then-delete in batches. A SETNX lock guards against
// concurrent deletions of the same source from parallel server instances
// (one MCP server is spawned per CLI session).
export async function deleteBySource(ctx: DocsContext, source: string): Promise<void> {
  const escaped = escapeTagValue(source);
  const lockKey = `${ctx.redis.keyPrefix}lock:delete:${escaped}`;

  // 30s TTL as a safety net against deadlocks from crashed holders.
  const acquired = await ctx.client.set(lockKey, "1", { NX: true, EX: 30 });
  if (!acquired) {
    throw new LockConflictError(source);
  }

  try {
    const BATCH = 1000;
    for (;;) {
      const result = await ctx.client.ft.search(ctx.redis.indexName, `@_source:{${escaped}}`, {
        RETURN: [],
        LIMIT: { from: 0, size: BATCH },
      });
      if (result.total === 0 || result.documents.length === 0) {
        return;
      }

      const pipeline = ctx.client.multi();
      for (const doc of result.documents) {
        pipeline.del(doc.id);
      }
      await pipeline.exec();

      if (result.documents.length < BATCH) {
        return;
      }
    }
  } finally {
    await ctx.client.del(lockKey);
  }
}

/** Read the source -> content-hash map recorded by previous syncs. */
export async function readSourceHashes(ctx: DocsContext): Promise<Map<string, string>> {
  const raw = await ctx.client.hGetAll(sourcesKey(ctx.redis));
  return new Map(Object.entries(raw));
}

export async function writeSourceHash(
  ctx: DocsContext,
  source: string,
  hash: string,
): Promise<void> {
  await ctx.client.hSet(sourcesKey(ctx.redis), source, hash);
}

export async function removeSourceHash(ctx: DocsContext, source: string): Promise<void> {
  await ctx.client.hDel(sourcesKey(ctx.redis), source);
}
