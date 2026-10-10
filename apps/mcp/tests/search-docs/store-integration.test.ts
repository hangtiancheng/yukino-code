import { afterEach, describe, expect, it } from "vitest";

import {
  deleteBySource,
  indexChunks,
  readSourceHashes,
  removeSourceHash,
  replaceSource,
  writeSourceHash,
} from "@/tools/docs/indexer.js";
import { retrieve } from "@/tools/docs/retriever.js";
import { ensureSchema, readMeta } from "@/tools/docs/store.js";
import { sha256 } from "@/tools/docs/utils.js";
import {
  fakeEmbedder,
  makeIndexFixture,
  type IndexFixture,
} from "./fixture.js";

let fixture: IndexFixture | null = null;

afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

describe("sqlite vector index", () => {
  it("indexes chunks and retrieves them by cosine similarity", async () => {
    fixture = makeIndexFixture();
    const { ctx } = fixture;
    await ensureSchema(ctx);

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
    expect(docs[0].score).toBeCloseTo(1, 5);
    for (const doc of docs) {
      expect(doc.score).toBeGreaterThanOrEqual(0);
      expect(doc.score).toBeLessThanOrEqual(1);
    }
  });

  it("returns nothing for an empty knowledge base", async () => {
    fixture = makeIndexFixture();
    await ensureSchema(fixture.ctx);
    expect(await retrieve(fixture.ctx, "anything", 3)).toEqual([]);
  });

  it("honours the result limit and orders by descending score", async () => {
    fixture = makeIndexFixture();
    const { ctx } = fixture;
    await ensureSchema(ctx);

    await indexChunks(ctx, [
      { id: "a:0", content: "alpha", metadata: { _source: "a.md" } },
      { id: "b:0", content: "bravo", metadata: { _source: "b.md" } },
      { id: "c:0", content: "charlie", metadata: { _source: "c.md" } },
    ]);

    const docs = await retrieve(ctx, "bravo", 2);
    expect(docs).toHaveLength(2);
    expect(docs[0].content).toBe("bravo");
    expect(docs[1].score).toBeLessThanOrEqual(docs[0].score);
  });

  it("deletes chunks by source, including filenames SQL would treat specially", async () => {
    fixture = makeIndexFixture();
    const { ctx } = fixture;
    await ensureSchema(ctx);

    const source = "guides/upload-test.v2 '; DROP TABLE chunks; --.md";
    await indexChunks(ctx, [
      { id: "h:0", content: "hostile one", metadata: { _source: source } },
      { id: "h:1", content: "hostile two", metadata: { _source: source } },
    ]);
    await deleteBySource(ctx, source);

    const remaining = ctx.db
      .prepare("SELECT count(*) AS n FROM chunks WHERE source = ?")
      .get(source) as { n: number };
    expect(remaining.n).toBe(0);
    expect(ctx.db.prepare("SELECT count(*) AS n FROM chunks").get()).toEqual({
      n: 0,
    });
  });

  it("round-trips the sources hash table", async () => {
    fixture = makeIndexFixture();
    const { ctx } = fixture;
    await ensureSchema(ctx);

    await writeSourceHash(ctx, "x.md", "hash-1");
    expect((await readSourceHashes(ctx)).get("x.md")).toBe("hash-1");
    await removeSourceHash(ctx, "x.md");
    expect((await readSourceHashes(ctx)).has("x.md")).toBe(false);
  });

  it("keeps the previous version intact when embedding fails mid-replace", async () => {
    fixture = makeIndexFixture();
    const { ctx } = fixture;
    await ensureSchema(ctx);

    const source = "replace.md";
    const prefix = sha256(source);
    await replaceSource(
      ctx,
      source,
      [
        {
          id: `${prefix}:0`,
          content: "old one",
          metadata: { _source: source },
        },
        {
          id: `${prefix}:1`,
          content: "old two",
          metadata: { _source: source },
        },
      ],
      "old-hash",
    );

    const failed = {
      ...ctx,
      embedder: {
        ...ctx.embedder,
        embedTexts: async () => {
          throw new Error("provider down");
        },
      },
    };
    await expect(
      replaceSource(
        failed,
        source,
        [{ id: `${prefix}:0`, content: "bad", metadata: { _source: source } }],
        "bad-hash",
      ),
    ).rejects.toThrow("provider down");

    expect((await readSourceHashes(ctx)).get(source)).toBe("old-hash");
    const docs = await retrieve(ctx, "old one", 2);
    expect(docs.map((d) => d.content)).toContain("old one");

    await replaceSource(
      ctx,
      source,
      [{ id: `${prefix}:0`, content: "new", metadata: { _source: source } }],
      "new-hash",
    );
    expect((await readSourceHashes(ctx)).get(source)).toBe("new-hash");
    const after = await retrieve(ctx, "new", 5);
    expect(after.map((d) => d.content)).toEqual(["new"]);
    expect(after.map((d) => d.id)).toEqual([`${prefix}:0`]);
  });

  it("wipes stale vectors when the embedding dimension changes", async () => {
    fixture = makeIndexFixture();
    const first = fixture.ctx;
    await ensureSchema(first);
    await indexChunks(first, [
      { id: "stale:0", content: "stale vector", metadata: { _source: "s.md" } },
    ]);
    await writeSourceHash(first, "s.md", "stale-hash");
    expect(readMeta(first.db, "dim")).toBe("8");

    const wider = { ...first, embedder: fakeEmbedder(16) };
    await ensureSchema(wider);

    expect(readMeta(wider.db, "dim")).toBe("16");
    expect(await retrieve(wider, "stale vector", 5)).toEqual([]);
    expect((await readSourceHashes(wider)).size).toBe(0);
  });

  it("sees writes made by another process without restarting", async () => {
    fixture = makeIndexFixture();
    const writer = fixture.ctx;
    await ensureSchema(writer);

    const reader = makeIndexFixture({ dbPath: fixture.index.dbPath });
    try {
      await ensureSchema(reader.ctx);
      expect(await retrieve(reader.ctx, "alpha", 3)).toEqual([]);

      await indexChunks(writer, [
        { id: "a:0", content: "alpha", metadata: { _source: "a.md" } },
      ]);

      const docs = await retrieve(reader.ctx, "alpha", 3);
      expect(docs.map((d) => d.content)).toEqual(["alpha"]);
    } finally {
      reader.cleanup();
    }
  });

  it("refreshes the cache after a local write", async () => {
    fixture = makeIndexFixture();
    const { ctx } = fixture;
    await ensureSchema(ctx);
    expect(await retrieve(ctx, "alpha", 3)).toEqual([]);

    await indexChunks(ctx, [
      { id: "a:0", content: "alpha", metadata: { _source: "a.md" } },
    ]);

    expect((await retrieve(ctx, "alpha", 3)).map((d) => d.content)).toEqual([
      "alpha",
    ]);
  });
});
