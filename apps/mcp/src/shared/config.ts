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

import { homedir } from "node:os";
import path from "node:path";

import { z } from "zod";

export interface EmbeddingConfig {
  /** Embedding model identifier, e.g. "text-embedding-v4". */
  model: string;
  /** OpenAI-compatible endpoint base URL (the "/embeddings" suffix is appended by the SDK). */
  baseUrl: string;
  apiKey: string;
}

export type EmbeddingConfigResult =
  | { ok: true; config: EmbeddingConfig }
  | { ok: false; reason: string };

export interface RedisConfig {
  url: string;
  indexName: string;
  keyPrefix: string;
}

export interface AppConfig {
  embedding: EmbeddingConfigResult;
  redis: RedisConfig;
  /** Directory scanned recursively for knowledge-base documents. */
  docsDir: string;
  /** HTTP transport listen address (only used with --http). */
  host: string;
  /** HTTP transport listen port (only used with --http). */
  port: number;
}

const EnvSchema = z.object({
  EMBEDDING_PROTOCOL: z.string().optional(),
  EMBEDDING_MODEL: z.string().optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  EMBEDDING_BASE_URL: z.string().optional(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  REDIS_INDEX_NAME: z.string().default("idx:yukino"),
  REDIS_KEY_PREFIX: z.string().default("yukino:"),
  YUKINO_DOCS_DIR: z
    .string()
    .default(path.resolve(homedir(), ".yukino", "docs")),
  // .catch: a malformed PORT in the environment must degrade to the default
  // instead of crashing the stdio server at startup.
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3300).catch(3300),
});

/** Empty strings behave as "unset" so placeholder env entries don't mask defaults. */
function dropEmptyValues(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && value.trim() !== "") {
      out[key] = value;
    }
  }
  return out;
}

function resolveEmbedding(
  env: z.infer<typeof EnvSchema>,
): EmbeddingConfigResult {
  // Only the OpenAI-compatible protocol is supported for now; the switch
  // exists so more protocols can be added without a config format change.
  const protocol = env.EMBEDDING_PROTOCOL ?? "openai";
  if (protocol !== "openai") {
    return {
      ok: false,
      reason: `unsupported EMBEDDING_PROTOCOL "${protocol}" (only "openai" is supported)`,
    };
  }
  const missing: string[] = [];
  const model = env.EMBEDDING_MODEL;
  const baseUrl = env.EMBEDDING_BASE_URL;
  const apiKey = env.EMBEDDING_API_KEY ?? env.OPENAI_API_KEY;
  if (!model) {
    missing.push("EMBEDDING_MODEL");
  }
  if (!baseUrl) {
    missing.push("EMBEDDING_BASE_URL");
  }
  if (!apiKey) {
    missing.push("EMBEDDING_API_KEY (or OPENAI_API_KEY)");
  }
  if (!model || !baseUrl || !apiKey) {
    return {
      ok: false,
      reason: `missing environment variables: ${missing.join(", ")}`,
    };
  }
  return { ok: true, config: { model, baseUrl, apiKey } };
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const parsed = EnvSchema.parse(dropEmptyValues(env));
  return {
    embedding: resolveEmbedding(parsed),
    redis: {
      url: parsed.REDIS_URL,
      indexName: parsed.REDIS_INDEX_NAME,
      keyPrefix: parsed.REDIS_KEY_PREFIX,
    },
    docsDir: parsed.YUKINO_DOCS_DIR,
    host: parsed.HOST,
    port: parsed.PORT,
  };
}
