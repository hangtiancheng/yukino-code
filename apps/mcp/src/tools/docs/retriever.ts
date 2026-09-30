import { z } from "zod";

import type { DocsContext } from "./redis-client.js";
import { float32ToBuffer } from "./utils.js";

export interface RetrievedDoc {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
}

// Runtime validation of a RediSearch KNN result document: the reply shape is
// not statically guaranteed, so parse with zod instead of casting. Fields are
// optional because zod v4 treats bare z.unknown() keys as required.
const DocValueSchema = z.looseObject({
  content: z.unknown().optional(),
  metadata: z.unknown().optional(),
  // RediSearch injects __vector_score (COSINE distance: 0=identical, 2=opposite).
  __vector_score: z.unknown().optional(),
});

const SearchResultSchema = z.object({
  total: z.number(),
  documents: z.array(
    z.object({
      id: z.string(),
      value: DocValueSchema,
    }),
  ),
});

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

// Convert COSINE distance [0, 2] to a similarity score [0, 1], higher is better.
function distanceToScore(distance: unknown): number {
  const d =
    typeof distance === "number" ? distance : Number(distance ?? Number.NaN);
  if (!Number.isFinite(d)) {
    return 0;
  }
  return (2 - d) / 2;
}

export async function retrieve(
  ctx: DocsContext,
  query: string,
  topK: number,
): Promise<RetrievedDoc[]> {
  const vec = float32ToBuffer(await ctx.embedder.embedText(query));

  const raw: unknown = await ctx.client.ft.search(
    ctx.redis.indexName,
    `*=>[KNN ${topK} @vector $vec]`,
    {
      PARAMS: { vec },
      DIALECT: 2,
      RETURN: ["content", "metadata", "__vector_score"],
      LIMIT: { from: 0, size: topK },
    },
  );

  const result = SearchResultSchema.parse(raw);
  const prefix = ctx.redis.keyPrefix;

  return (
    result.documents
      .map((doc) => ({
        id: doc.id.startsWith(prefix) ? doc.id.slice(prefix.length) : doc.id,
        content: String(doc.value.content ?? ""),
        metadata: parseMetadata(doc.value.metadata),
        score: distanceToScore(doc.value.__vector_score),
      }))
      // RediSearch does not guarantee KNN results ordered by distance.
      .sort((a, b) => b.score - a.score)
  );
}
