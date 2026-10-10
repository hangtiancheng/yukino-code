import { logger } from "@/shared/logger.js";
import { splitMarkdown } from "./chunker.js";
import {
  deleteBySource,
  replaceSource,
  LockConflictError,
  readSourceHashes,
  type IndexChunk,
} from "./indexer.js";
import type { DocsContext } from "./store.js";
import { scanDocsDir } from "./scanner.js";
import { sha256 } from "./utils.js";

export interface SyncStats {
  indexed: number;
  skipped: number;
  removed: number;
  failed: number;
  chunks: number;
}

export async function buildChunks(
  source: string,
  content: string,
): Promise<IndexChunk[]> {
  const sourceHash = sha256(source);
  const parts = await splitMarkdown(content);
  return parts
    .filter((part) => part.content.trim() !== "")
    .map((part, i) => ({
      id: `${sourceHash}:${String(i)}`,
      content: part.content,
      metadata: { _source: source, title: part.title },
    }));
}

export async function syncDocs(
  ctx: DocsContext,
  docsDir: string,
): Promise<SyncStats> {
  const docs = await scanDocsDir(docsDir);
  const known = await readSourceHashes(ctx);
  const stats: SyncStats = {
    indexed: 0,
    skipped: 0,
    removed: 0,
    failed: 0,
    chunks: 0,
  };

  const seen = new Set<string>();
  for (const doc of docs) {
    seen.add(doc.source);
    if (doc.content === null) {
      stats.failed++;
      continue;
    }
    const hash = sha256(doc.content);
    if (known.get(doc.source) === hash) {
      stats.skipped++;
      continue;
    }
    try {
      const count = await replaceSource(
        ctx,
        doc.source,
        await buildChunks(doc.source, doc.content),
        hash,
      );
      stats.indexed++;
      stats.chunks += count;
    } catch (err) {
      if (err instanceof LockConflictError) {
        stats.skipped++;
        logger.info(
          { source: doc.source },
          "another instance is indexing this source, skipping",
        );
        continue;
      }
      stats.failed++;
      logger.warn({ err, source: doc.source }, "failed to index document");
    }
  }

  for (const source of known.keys()) {
    if (seen.has(source)) {
      continue;
    }
    try {
      await deleteBySource(ctx, source);
      stats.removed++;
    } catch (err) {
      if (err instanceof LockConflictError) {
        stats.skipped++;
        continue;
      }
      stats.failed++;
      logger.warn(
        { err, source },
        "failed to remove deleted document from index",
      );
    }
  }

  logger.info({ docsDir, ...stats }, "docs sync complete");
  return stats;
}
