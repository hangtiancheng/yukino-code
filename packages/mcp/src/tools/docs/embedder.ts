import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { embed, embedMany, type EmbeddingModel } from "ai";

import type { EmbeddingConfig } from "@/shared/config.js";

export const EMBED_BATCH_SIZE = 10;

export interface Embedder {
  embedText(text: string): Promise<number[]>;
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
      const { embedding } = await embed({
        model,
        value: text,
        abortSignal: AbortSignal.timeout(20_000),
        maxRetries: 1,
      });
      return embedding;
    },
    async embedTexts(texts: string[]): Promise<number[][]> {
      const results: number[][] = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
        const { embeddings } = await embedMany({
          model,
          abortSignal: AbortSignal.timeout(20_000),
          maxRetries: 1,
          values: texts.slice(i, i + EMBED_BATCH_SIZE),
        });
        results.push(...embeddings);
      }
      return results;
    },
  };
}
