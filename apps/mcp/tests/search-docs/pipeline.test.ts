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

import { createClient } from "redis";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LockConflictError } from "@/tools/docs/indexer.js";
import { buildChunks, syncDocs } from "@/tools/docs/pipeline.js";
import type { DocsContext } from "@/tools/docs/redis-client.js";
import { sha256 } from "@/tools/docs/utils.js";

const indexerMocks = vi.hoisted(() => ({
  deleteBySource: vi.fn<(ctx: unknown, source: string) => Promise<void>>(async () => undefined),
  indexChunks: vi.fn<(ctx: unknown, chunks: { id: string }[]) => Promise<number>>(
    async (_ctx, chunks) => chunks.length,
  ),
  readSourceHashes: vi.fn<() => Promise<Map<string, string>>>(async () => new Map()),
  removeSourceHash: vi.fn<(ctx: unknown, source: string) => Promise<void>>(async () => undefined),
  writeSourceHash: vi.fn<(ctx: unknown, source: string, hash: string) => Promise<void>>(
    async () => undefined,
  ),
}));

const scannerMocks = vi.hoisted(() => ({
  scanDocsDir: vi.fn<() => Promise<{ source: string; content: string }[]>>(async () => []),
}));

vi.mock("@/tools/docs/indexer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/tools/docs/indexer.js")>();
  return { ...indexerMocks, LockConflictError: actual.LockConflictError };
});
vi.mock("@/tools/docs/scanner.js", () => scannerMocks);

function makeCtx(): DocsContext {
  return {
    // Never connected: syncDocs only forwards the context to (mocked) indexer functions.
    client: createClient(),
    embedder: {
      embedText: async () => [0],
      embedTexts: async (texts: string[]) => texts.map(() => [0]),
    },
    redis: {
      url: "redis://localhost:6379",
      indexName: "idx:test",
      keyPrefix: "test:",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  indexerMocks.readSourceHashes.mockResolvedValue(new Map());
  scannerMocks.scanDocsDir.mockResolvedValue([]);
});

describe("buildChunks", () => {
  it("assigns deterministic ids derived from the source", async () => {
    const chunks = await buildChunks("a.md", "# One\nx\n\n# Two\ny");
    const prefix = sha256("a.md");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map((c) => c.id)).toEqual(chunks.map((_, i) => `${prefix}:${String(i)}`));
    expect(await buildChunks("a.md", "# One\nx\n\n# Two\ny")).toEqual(chunks);
  });

  it("filters blank chunks and records source/title metadata", async () => {
    const chunks = await buildChunks("a.md", "\n\n# Title\nbody");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata).toEqual({ _source: "a.md", title: "Title" });
  });
});

describe("syncDocs", () => {
  it("indexes new files and records their content hash", async () => {
    const content = "# Doc\nhello";
    scannerMocks.scanDocsDir.mockResolvedValue([{ source: "new.md", content }]);

    const stats = await syncDocs(makeCtx(), "/docs");

    expect(indexerMocks.deleteBySource).toHaveBeenCalledWith(expect.anything(), "new.md");
    expect(indexerMocks.indexChunks).toHaveBeenCalledTimes(1);
    expect(indexerMocks.writeSourceHash).toHaveBeenCalledWith(
      expect.anything(),
      "new.md",
      sha256(content),
    );
    expect(stats).toEqual({
      indexed: 1,
      skipped: 0,
      removed: 0,
      failed: 0,
      chunks: 1,
    });
  });

  it("skips files whose content hash is unchanged", async () => {
    const content = "# Same";
    scannerMocks.scanDocsDir.mockResolvedValue([{ source: "same.md", content }]);
    indexerMocks.readSourceHashes.mockResolvedValue(new Map([["same.md", sha256(content)]]));

    const stats = await syncDocs(makeCtx(), "/docs");

    expect(indexerMocks.deleteBySource).not.toHaveBeenCalled();
    expect(indexerMocks.indexChunks).not.toHaveBeenCalled();
    expect(stats.skipped).toBe(1);
  });

  it("removes index records for files deleted from disk", async () => {
    indexerMocks.readSourceHashes.mockResolvedValue(new Map([["gone.md", "stale-hash"]]));

    const stats = await syncDocs(makeCtx(), "/docs");

    expect(indexerMocks.deleteBySource).toHaveBeenCalledWith(expect.anything(), "gone.md");
    expect(indexerMocks.removeSourceHash).toHaveBeenCalledWith(expect.anything(), "gone.md");
    expect(stats.removed).toBe(1);
  });

  it("continues past per-file failures", async () => {
    scannerMocks.scanDocsDir.mockResolvedValue([
      { source: "bad.md", content: "# Bad" },
      { source: "good.md", content: "# Good" },
    ]);
    indexerMocks.indexChunks
      .mockRejectedValueOnce(new Error("embed exploded"))
      .mockResolvedValueOnce(1);

    const stats = await syncDocs(makeCtx(), "/docs");

    expect(stats.failed).toBe(1);
    expect(stats.indexed).toBe(1);
    expect(indexerMocks.writeSourceHash).toHaveBeenCalledTimes(1);
    expect(indexerMocks.writeSourceHash).toHaveBeenCalledWith(
      expect.anything(),
      "good.md",
      expect.any(String),
    );
  });

  it("counts lock conflicts as skipped, not failed", async () => {
    scannerMocks.scanDocsDir.mockResolvedValue([{ source: "busy.md", content: "# Busy" }]);
    indexerMocks.deleteBySource.mockRejectedValueOnce(new LockConflictError("busy.md"));

    const stats = await syncDocs(makeCtx(), "/docs");

    expect(stats.skipped).toBe(1);
    expect(stats.failed).toBe(0);
    expect(indexerMocks.writeSourceHash).not.toHaveBeenCalled();
  });
});
