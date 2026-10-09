import { blobToVector, normalizeVector } from "./utils.js";
import type { DocsContext, VectorCache } from "./store.js";
import { currentDataVersion, readMeta } from "./store.js";

export interface RetrievedDoc {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Load every stored vector into one contiguous matrix. Vectors are stored
 * L2-normalized, so scoring is a plain dot product; at the scale of a personal
 * knowledge base (thousands of chunks) scanning them costs single-digit
 * milliseconds, which is far less than the round trip to an external index.
 */
function buildCache(ctx: DocsContext, dataVersion: number): VectorCache {
  const dim = Number(readMeta(ctx.db, "dim"));
  const rows = ctx.db.prepare("SELECT id, vector FROM chunks").all() as {
    id: unknown;
    vector: unknown;
  }[];
  if (!Number.isInteger(dim) || dim <= 0) {
    return { dataVersion, dim: 0, ids: [], matrix: new Float32Array(0) };
  }

  const matrix = new Float32Array(rows.length * dim);
  const ids: string[] = [];
  for (const row of rows) {
    if (typeof row.id !== "string" || !(row.vector instanceof Uint8Array)) {
      continue;
    }
    // A row written under a different dimension can only be stale data; skip
    // it rather than misreading the matrix.
    if (row.vector.byteLength !== dim * 4) {
      continue;
    }
    matrix.set(blobToVector(row.vector, dim), ids.length * dim);
    ids.push(row.id);
  }
  return {
    dataVersion,
    dim,
    ids,
    matrix: matrix.subarray(0, ids.length * dim),
  };
}

function ensureCache(ctx: DocsContext): VectorCache {
  const dataVersion = currentDataVersion(ctx.db);
  const cache = ctx.cache;
  if (cache !== null && cache.dataVersion === dataVersion) {
    return cache;
  }
  const rebuilt = buildCache(ctx, dataVersion);
  ctx.cache = rebuilt;
  return rebuilt;
}

interface Scored {
  index: number;
  score: number;
}

/** Top-K selection by a single pass, keeping a sorted array of at most K. */
function topK(scores: Float32Array, k: number): Scored[] {
  const best: Scored[] = [];
  for (let i = 0; i < scores.length; i++) {
    const score = scores[i];
    if (best.length === k && score <= best[best.length - 1].score) {
      continue;
    }
    let at = best.length;
    while (at > 0 && best[at - 1].score < score) {
      at--;
    }
    best.splice(at, 0, { index: i, score });
    if (best.length > k) {
      best.pop();
    }
  }
  return best;
}

export async function retrieve(
  ctx: DocsContext,
  query: string,
  limit: number,
): Promise<RetrievedDoc[]> {
  const queryVector = normalizeVector(await ctx.embedder.embedText(query));
  const cache = ensureCache(ctx);
  if (cache.ids.length === 0 || queryVector.length !== cache.dim) {
    return [];
  }

  const scores = new Float32Array(cache.ids.length);
  for (let i = 0; i < cache.ids.length; i++) {
    const offset = i * cache.dim;
    let dot = 0;
    for (let d = 0; d < cache.dim; d++) {
      dot += cache.matrix[offset + d] * queryVector[d];
    }
    // Guard the [-1, 1] cosine range against float error before mapping it.
    scores[i] = dot < -1 ? -1 : dot > 1 ? 1 : dot;
  }

  const selected = topK(scores, limit);
  const read = ctx.db.prepare(
    "SELECT content, metadata FROM chunks WHERE id = ?",
  );

  const docs: RetrievedDoc[] = [];
  for (const hit of selected) {
    const row = read.get(cache.ids[hit.index]) as
      { content?: unknown; metadata?: unknown } | undefined;
    if (row === undefined) {
      continue;
    }
    docs.push({
      id: cache.ids[hit.index],
      content: String(row.content ?? ""),
      metadata: parseMetadata(row.metadata),
      // Report the score on the same [0, 1] scale as the previous vector index:
      // cosine distance d mapped through (2 - d) / 2, which is (1 + cosine) / 2
      // — 1 for identical vectors and 0 for opposite ones.
      score: (1 + hit.score) / 2,
    });
  }
  return docs;
}
