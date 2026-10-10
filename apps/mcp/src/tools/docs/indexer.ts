import type { DocsContext } from "./store.js";
import { invalidateCache, isBusyError } from "./store.js";
import { normalizeVector, vectorToBlob } from "./utils.js";

export interface IndexChunk {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
}

const MAX_CONTENT_LENGTH = 8192;

export class LockConflictError extends Error {
  constructor(source: string) {
    super(`another process is writing "${source}" to the index`);
    this.name = "LockConflictError";
  }
}

function transact<T>(ctx: DocsContext, label: string, work: () => T): T {
  try {
    ctx.db.exec("BEGIN IMMEDIATE");
  } catch (err) {
    throw isBusyError(err) ? new LockConflictError(label) : err;
  }
  try {
    const result = work();
    ctx.db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      ctx.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

function prepareUpsert(ctx: DocsContext) {
  return ctx.db.prepare(
    "INSERT INTO chunks (id, source, content, metadata, created_at, vector) " +
      "VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET " +
      "source = excluded.source, content = excluded.content, " +
      "metadata = excluded.metadata, created_at = excluded.created_at, " +
      "vector = excluded.vector",
  );
}

function insertChunk(
  insert: ReturnType<typeof prepareUpsert>,
  source: string,
  chunk: IndexChunk,
  embedding: number[],
  createdAt: string,
): void {
  insert.run(
    chunk.id,
    source,
    chunk.content.slice(0, MAX_CONTENT_LENGTH),
    JSON.stringify(chunk.metadata),
    createdAt,
    vectorToBlob(normalizeVector(embedding)),
  );
}

export async function indexChunks(
  ctx: DocsContext,
  chunks: IndexChunk[],
): Promise<number> {
  if (chunks.length === 0) {
    return 0;
  }
  const vectors = await ctx.embedder.embedTexts(chunks.map((c) => c.content));
  const createdAt = new Date().toISOString();
  transact(ctx, String(chunks[0]?.metadata["_source"] ?? "index"), () => {
    const insert = prepareUpsert(ctx);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      insertChunk(
        insert,
        String(chunk.metadata["_source"] ?? ""),
        chunk,
        vectors[i],
        createdAt,
      );
    }
  });
  invalidateCache(ctx);
  return chunks.length;
}

export async function replaceSource(
  ctx: DocsContext,
  source: string,
  chunks: IndexChunk[],
  hash: string | null,
): Promise<number> {
  const vectors = chunks.length
    ? await ctx.embedder.embedTexts(chunks.map((c) => c.content))
    : [];
  if (
    vectors.length !== chunks.length ||
    vectors.some((v) => v.length === 0 || v.some((n) => !Number.isFinite(n)))
  ) {
    throw new Error("Embedding provider returned invalid or missing vectors.");
  }

  const createdAt = new Date().toISOString();
  transact(ctx, source, () => {
    ctx.db.prepare("DELETE FROM chunks WHERE source = ?").run(source);
    const insert = prepareUpsert(ctx);
    for (let i = 0; i < chunks.length; i++) {
      insertChunk(insert, source, chunks[i], vectors[i], createdAt);
    }
    if (hash === null) {
      ctx.db.prepare("DELETE FROM sources WHERE source = ?").run(source);
    } else {
      ctx.db
        .prepare(
          "INSERT INTO sources (source, hash) VALUES (?, ?) " +
            "ON CONFLICT(source) DO UPDATE SET hash = excluded.hash",
        )
        .run(source, hash);
    }
  });
  invalidateCache(ctx);
  return chunks.length;
}

export async function deleteBySource(
  ctx: DocsContext,
  source: string,
): Promise<void> {
  await replaceSource(ctx, source, [], null);
}

export async function readSourceHashes(
  ctx: DocsContext,
): Promise<Map<string, string>> {
  const rows = ctx.db.prepare("SELECT source, hash FROM sources").all() as {
    source: unknown;
    hash: unknown;
  }[];
  const hashes = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.source === "string" && typeof row.hash === "string") {
      hashes.set(row.source, row.hash);
    }
  }
  return hashes;
}

export async function writeSourceHash(
  ctx: DocsContext,
  source: string,
  hash: string,
): Promise<void> {
  ctx.db
    .prepare(
      "INSERT INTO sources (source, hash) VALUES (?, ?) " +
        "ON CONFLICT(source) DO UPDATE SET hash = excluded.hash",
    )
    .run(source, hash);
}

export async function removeSourceHash(
  ctx: DocsContext,
  source: string,
): Promise<void> {
  ctx.db.prepare("DELETE FROM sources WHERE source = ?").run(source);
}
