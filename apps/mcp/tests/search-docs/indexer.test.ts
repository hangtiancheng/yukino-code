import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  deleteBySource,
  LockConflictError,
  readSourceHashes,
  replaceSource,
  type IndexChunk,
} from "@/tools/docs/indexer.js";
import { closeStore, type DocsContext } from "@/tools/docs/store.js";
import { sha256 } from "@/tools/docs/utils.js";
import { makeIndexFixture, type IndexFixture } from "./fixture.js";

let fixture: IndexFixture | null = null;

afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

/** Chunk id as the pipeline derives it: sha256(source) + ordinal. */
function idOf(source: string, ordinal: number): string {
  return `${sha256(source)}:${String(ordinal)}`;
}

function chunk(source: string, ordinal: number, content: string): IndexChunk {
  return {
    id: idOf(source, ordinal),
    content,
    metadata: { _source: source, title: "" },
  };
}

function storedContent(ctx: DocsContext, id: string): string | undefined {
  const row = ctx.db
    .prepare("SELECT content FROM chunks WHERE id = ?")
    .get(id) as { content?: string } | undefined;
  return row?.content;
}

function chunkCount(ctx: DocsContext, source: string): number {
  const row = ctx.db
    .prepare("SELECT count(*) AS n FROM chunks WHERE source = ?")
    .get(source) as { n: number };
  return row.n;
}

describe("atomic RAG source replacement", () => {
  it("never deletes existing chunks or updates the source hash when embedding fails", async () => {
    fixture = makeIndexFixture();
    const { ctx } = fixture;
    const source = "a.md";
    await replaceSource(ctx, source, [chunk(source, 0, "old one")], "old-hash");

    ctx.embedder = {
      ...ctx.embedder,
      embedTexts: async () => {
        throw new Error("provider down");
      },
    };
    await expect(
      replaceSource(ctx, source, [chunk(source, 0, "new")], "new-hash"),
    ).rejects.toThrow("provider down");

    expect(chunkCount(ctx, source)).toBe(1);
    expect(storedContent(ctx, idOf(source, 0))).toBe("old one");
    expect((await readSourceHashes(ctx)).get(source)).toBe("old-hash");
  });

  it("replaces stale chunks, new chunks and the source hash in one commit", async () => {
    fixture = makeIndexFixture();
    const { ctx } = fixture;
    const source = "replace.md";
    await replaceSource(
      ctx,
      source,
      [chunk(source, 0, "old one"), chunk(source, 1, "old two")],
      "old-hash",
    );

    await replaceSource(ctx, source, [chunk(source, 0, "new")], "new-hash");

    expect(storedContent(ctx, idOf(source, 0))).toBe("new");
    expect(storedContent(ctx, idOf(source, 1))).toBeUndefined();
    expect((await readSourceHashes(ctx)).get(source)).toBe("new-hash");
  });

  it("removes chunks and the recorded hash when a source is deleted", async () => {
    fixture = makeIndexFixture();
    const { ctx } = fixture;
    const source = "gone.md";
    await replaceSource(ctx, source, [chunk(source, 0, "bye")], "hash");

    await deleteBySource(ctx, source);

    expect(chunkCount(ctx, source)).toBe(0);
    expect((await readSourceHashes(ctx)).has(source)).toBe(false);
  });

  it("rolls the whole replacement back when a write fails mid-transaction", async () => {
    fixture = makeIndexFixture();
    const { ctx } = fixture;
    const source = "boom.md";
    await replaceSource(ctx, source, [chunk(source, 0, "keep me")], "h1");

    // Metadata that cannot be serialized explodes after the delete but before
    // the commit, so the previous chunks and hash must survive untouched.
    const circular: Record<string, unknown> = { _source: source };
    circular["self"] = circular;
    await expect(
      replaceSource(
        ctx,
        source,
        [{ id: "boom:0", content: "new", metadata: circular }],
        "h2",
      ),
    ).rejects.toThrow();

    expect(chunkCount(ctx, source)).toBe(1);
    expect(storedContent(ctx, idOf(source, 0))).toBe("keep me");
    expect((await readSourceHashes(ctx)).get(source)).toBe("h1");
  });

  it("reports a lock conflict instead of waiting forever for another writer", async () => {
    fixture = makeIndexFixture();
    const { ctx, index } = fixture;

    // A sibling process holding the write lock. The fixture's own handle uses
    // the production 5s busy timeout, so swap in a short one for the test.
    const sibling = new DatabaseSync(index.dbPath, { timeout: 50 });
    sibling.exec("BEGIN IMMEDIATE");
    closeStore(ctx.db);
    ctx.db = new DatabaseSync(index.dbPath, { timeout: 50 });
    try {
      await expect(
        replaceSource(ctx, "busy.md", [chunk("busy.md", 0, "x")], "h"),
      ).rejects.toBeInstanceOf(LockConflictError);
    } finally {
      sibling.exec("ROLLBACK");
      sibling.close();
    }

    // The lock is released, so the same write now succeeds.
    await expect(
      replaceSource(ctx, "busy.md", [chunk("busy.md", 0, "x")], "h"),
    ).resolves.toBe(1);
  });
});
