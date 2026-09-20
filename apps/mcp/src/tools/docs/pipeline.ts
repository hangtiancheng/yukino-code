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

import { logger } from "../../shared/logger.js";
import { splitMarkdown } from "./chunker.js";
import {
  deleteBySource,
  indexChunks,
  LockConflictError,
  readSourceHashes,
  removeSourceHash,
  writeSourceHash,
  type IndexChunk,
} from "./indexer.js";
import type { DocsContext } from "./redis-client.js";
import { scanDocsDir } from "./scanner.js";
import { sha256 } from "./utils.js";

export interface SyncStats {
  indexed: number;
  skipped: number;
  removed: number;
  failed: number;
  chunks: number;
}

/** Split a document into index chunks with deterministic ids (idempotent re-index). */
export async function buildChunks(source: string, content: string): Promise<IndexChunk[]> {
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

/**
 * Incrementally sync the docs directory into the vector index:
 * - unchanged files (same content sha256 as the recorded one) are skipped,
 * - new/changed files are delete-then-reindexed under their _source,
 * - records of files deleted from disk are removed from the index.
 * Per-file failures are logged and skipped so one bad file never aborts the
 * sync; a lock conflict means a sibling server instance is already handling
 * that source and counts as skipped, not failed.
 */
export async function syncDocs(ctx: DocsContext, docsDir: string): Promise<SyncStats> {
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
    const hash = sha256(doc.content);
    if (known.get(doc.source) === hash) {
      stats.skipped++;
      continue;
    }
    try {
      await deleteBySource(ctx, doc.source);
      const count = await indexChunks(ctx, await buildChunks(doc.source, doc.content));
      await writeSourceHash(ctx, doc.source, hash);
      stats.indexed++;
      stats.chunks += count;
    } catch (err) {
      if (err instanceof LockConflictError) {
        stats.skipped++;
        logger.info({ source: doc.source }, "another instance is indexing this source, skipping");
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
      await removeSourceHash(ctx, source);
      stats.removed++;
    } catch (err) {
      if (err instanceof LockConflictError) {
        stats.skipped++;
        continue;
      }
      stats.failed++;
      logger.warn({ err, source }, "failed to remove deleted document from index");
    }
  }

  logger.info({ docsDir, ...stats }, "docs sync complete");
  return stats;
}
