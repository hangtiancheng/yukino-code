import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LockConflictError } from "@/tools/docs/indexer.js";
import { buildChunks, syncDocs } from "@/tools/docs/pipeline.js";
import type { DocsContext } from "@/tools/docs/store.js";
import { sha256 } from "@/tools/docs/utils.js";
import { makeIndexFixture, type IndexFixture } from "./fixture.js";

const indexerMocks = vi.hoisted(() => ({
  deleteBySource: vi.fn<(ctx: unknown, source: string) => Promise<void>>(
    async () => undefined,
  ),
  replaceSource: vi.fn<
    (ctx: unknown, source: string, chunks: { id: string }[]) => Promise<number>
  >(async (_ctx, _source, chunks) => chunks.length),
  readSourceHashes: vi.fn<() => Promise<Map<string, string>>>(
    async () => new Map(),
  ),
  removeSourceHash: vi.fn<(ctx: unknown, source: string) => Promise<void>>(
    async () => undefined,
  ),
  writeSourceHash: vi.fn<
    (ctx: unknown, source: string, hash: string) => Promise<void>
  >(async () => undefined),
}));

const scannerMocks = vi.hoisted(() => ({
  scanDocsDir: vi.fn<
    () => Promise<{ source: string; content: string | null }[]>
  >(async () => []),
}));

vi.mock("@/tools/docs/indexer.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/tools/docs/indexer.js")>();
  return { ...indexerMocks, LockConflictError: actual.LockConflictError };
});
vi.mock("@/tools/docs/scanner.js", () => scannerMocks);

let fixture: IndexFixture | null = null;

function makeCtx(): DocsContext {
  if (fixture === null) {
    fixture = makeIndexFixture();
  }
  return fixture.ctx;
}

beforeEach(() => {
  vi.clearAllMocks();
  indexerMocks.readSourceHashes.mockResolvedValue(new Map());
  scannerMocks.scanDocsDir.mockResolvedValue([]);
});

afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

describe("buildChunks", () => {
  it("assigns deterministic ids derived from the source", async () => {
    const chunks = await buildChunks("a.md", "# One\nx\n\n# Two\ny");
    const prefix = sha256("a.md");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map((c) => c.id)).toEqual(
      chunks.map((_, i) => `${prefix}:${String(i)}`),
    );
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

    expect(indexerMocks.replaceSource).toHaveBeenCalledWith(
      expect.anything(),
      "new.md",
      expect.any(Array),
      sha256(content),
    );
    expect(indexerMocks.replaceSource).toHaveBeenCalledTimes(1);

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
    scannerMocks.scanDocsDir.mockResolvedValue([
      { source: "same.md", content },
    ]);
    indexerMocks.readSourceHashes.mockResolvedValue(
      new Map([["same.md", sha256(content)]]),
    );

    const stats = await syncDocs(makeCtx(), "/docs");

    expect(indexerMocks.deleteBySource).not.toHaveBeenCalled();
    expect(indexerMocks.replaceSource).not.toHaveBeenCalled();
    expect(stats.skipped).toBe(1);
  });

  it("removes index records for files deleted from disk", async () => {
    indexerMocks.readSourceHashes.mockResolvedValue(
      new Map([["gone.md", "stale-hash"]]),
    );

    const stats = await syncDocs(makeCtx(), "/docs");

    expect(indexerMocks.deleteBySource).toHaveBeenCalledWith(
      expect.anything(),
      "gone.md",
    );

    expect(stats.removed).toBe(1);
  });

  it("continues past per-file failures", async () => {
    scannerMocks.scanDocsDir.mockResolvedValue([
      { source: "bad.md", content: "# Bad" },
      { source: "good.md", content: "# Good" },
    ]);
    indexerMocks.replaceSource
      .mockRejectedValueOnce(new Error("embed exploded"))
      .mockResolvedValueOnce(1);

    const stats = await syncDocs(makeCtx(), "/docs");

    expect(stats.failed).toBe(1);
    expect(stats.indexed).toBe(1);
    expect(indexerMocks.replaceSource).toHaveBeenCalledTimes(2);
  });

  it("counts lock conflicts as skipped, not failed", async () => {
    scannerMocks.scanDocsDir.mockResolvedValue([
      { source: "busy.md", content: "# Busy" },
    ]);
    indexerMocks.replaceSource.mockRejectedValueOnce(
      new LockConflictError("busy.md"),
    );

    const stats = await syncDocs(makeCtx(), "/docs");

    expect(stats.skipped).toBe(1);
    expect(stats.failed).toBe(0);
    expect(indexerMocks.writeSourceHash).not.toHaveBeenCalled();
  });
  it("preserves the old index for files that could not be read", async () => {
    scannerMocks.scanDocsDir.mockResolvedValue([
      { source: "unreadable.md", content: null },
    ]);
    indexerMocks.readSourceHashes.mockResolvedValue(
      new Map([["unreadable.md", "old"]]),
    );
    const stats = await syncDocs(makeCtx(), "/docs");
    expect(stats.failed).toBe(1);
    expect(indexerMocks.deleteBySource).not.toHaveBeenCalled();
    expect(indexerMocks.replaceSource).not.toHaveBeenCalled();
  });
});
