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

// Redis Stack integration tests: run only when REDIS_URL is explicitly set
// (requires a reachable Redis with the RediSearch module). Uses a fake
// deterministic embedder so no embedding API access is needed.
//   REDIS_URL=redis://localhost:6379 pnpm test

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RedisConfig } from "@/shared/config.js";
import type { Embedder } from "@/tools/docs/embedder.js";
import {
  deleteBySource,
  indexChunks,
  readSourceHashes,
  removeSourceHash,
  writeSourceHash,
} from "@/tools/docs/indexer.js";
import {
  closeRedis,
  connectRedis,
  ensureIndex,
  sourcesKey,
  type DocsContext,
} from "@/tools/docs/redis-client.js";
import { retrieve } from "@/tools/docs/retriever.js";

const redisUrl = process.env["REDIS_URL"];

function fakeEmbedder(dim: number): Embedder {
  const embedOne = (text: string): number[] => {
    const vector = new Array<number>(dim).fill(0.001);
    for (let i = 0; i < text.length; i++) {
      vector[text.charCodeAt(i) % dim] += 1;
    }
    return vector;
  };
  return {
    embedText: (text) => Promise.resolve(embedOne(text)),
    embedTexts: (texts) => Promise.resolve(texts.map(embedOne)),
  };
}

describe.skipIf(!redisUrl)("redis integration", () => {
  const redis: RedisConfig = {
    url: redisUrl ?? "",
    indexName: `idx:yukino-mcp-test-${String(process.pid)}`,
    keyPrefix: `yukino-mcp-test-${String(process.pid)}:`,
  };
  let ctx: DocsContext;

  beforeAll(async () => {
    const client = await connectRedis(redis);
    ctx = { client, embedder: fakeEmbedder(8), redis };
    await ensureIndex(ctx);
  });

  afterAll(async () => {
    try {
      await ctx.client.ft.dropIndex(redis.indexName);
    } catch {
      // Index may already be gone.
    }
    for await (const keys of ctx.client.scanIterator({
      MATCH: `${redis.keyPrefix}*`,
      COUNT: 500,
    })) {
      if (keys.length > 0) {
        await ctx.client.del(keys);
      }
    }
    await ctx.client.del(sourcesKey(redis));
    await closeRedis(ctx.client);
  });

  it("indexes chunks and retrieves them by KNN with scores in [0, 1]", async () => {
    await indexChunks(ctx, [
      {
        id: "a:0",
        content: "alpha content",
        metadata: { _source: "a.md", title: "Alpha" },
      },
      {
        id: "b:0",
        content: "bravo content",
        metadata: { _source: "b.md", title: "Bravo" },
      },
    ]);

    const docs = await retrieve(ctx, "alpha content", 2);
    expect(docs).toHaveLength(2);
    expect(docs[0].content).toBe("alpha content");
    expect(docs[0].metadata["_source"]).toBe("a.md");
    for (const doc of docs) {
      expect(doc.score).toBeGreaterThanOrEqual(0);
      expect(doc.score).toBeLessThanOrEqual(1);
    }
  });

  it("deletes chunks by source, including hostile tag values", async () => {
    const source = "my-file.v2.md";
    await indexChunks(ctx, [
      {
        id: "h:0",
        content: "hostile one",
        metadata: { _source: source, title: "" },
      },
      {
        id: "h:1",
        content: "hostile two",
        metadata: { _source: source, title: "" },
      },
    ]);
    await deleteBySource(ctx, source);

    const remaining = await ctx.client.ft.search(
      redis.indexName,
      `@_source:{${source.replace(/[^\p{L}\p{N}_]/gu, "\\$&")}}`,
      { LIMIT: { from: 0, size: 10 } },
    );
    expect(remaining.total).toBe(0);
  });

  it("round-trips the sources meta hash", async () => {
    await writeSourceHash(ctx, "x.md", "hash-1");
    expect((await readSourceHashes(ctx)).get("x.md")).toBe("hash-1");
    await removeSourceHash(ctx, "x.md");
    expect((await readSourceHashes(ctx)).has("x.md")).toBe(false);
  });

  it("recreates the index and wipes stale data on dimension change", async () => {
    await indexChunks(ctx, [
      {
        id: "stale:0",
        content: "stale vector",
        metadata: { _source: "stale.md", title: "" },
      },
    ]);
    await writeSourceHash(ctx, "stale.md", "stale-hash");

    const wider: DocsContext = { ...ctx, embedder: fakeEmbedder(16) };
    await ensureIndex(wider);

    const docs = await retrieve(wider, "stale vector", 5);
    expect(docs).toHaveLength(0);
    expect((await readSourceHashes(wider)).size).toBe(0);

    ctx = wider;
  });
});
