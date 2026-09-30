import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { embed, embedMany, type EmbeddingModel } from "ai";

import type { EmbeddingConfig } from "../../shared/config.js";

// OpenAI-compatible endpoints cap inputs per request (DashScope
// text-embedding-v4 allows 10) while the SDK default is 2048 per call, so
// large documents would fail with "batch size is invalid" without splitting.
export const EMBED_BATCH_SIZE = 10;

export interface Embedder {
  /** Embed a single text (used for queries and the dimension probe). */
  embedText(text: string): Promise<number[]>;
  /** Embed many texts preserving input order (used for indexing). */
  embedTexts(texts: string[]): Promise<number[][]>;
}

export function createEmbedder(config: EmbeddingConfig): Embedder {
  const provider = createOpenAICompatible({
    name: "openai",
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
  });
  const model: EmbeddingModel = provider.embeddingModel(config.model);

  return {
    async embedText(text: string): Promise<number[]> {
      const { embedding } = await embed({ model, value: text });
      return embedding;
    },
    async embedTexts(texts: string[]): Promise<number[][]> {
      const results: number[][] = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
        const { embeddings } = await embedMany({
          model,
          values: texts.slice(i, i + EMBED_BATCH_SIZE),
        });
        results.push(...embeddings);
      }
      return results;
    },
  };
}
