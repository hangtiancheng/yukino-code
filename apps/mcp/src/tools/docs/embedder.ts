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
