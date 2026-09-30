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
  { ok: true; config: EmbeddingConfig } | { ok: false; reason: string };

export interface RedisConfig {
  url: string;
  indexName: string;
  keyPrefix: string;
}

export interface GitHubConfig {
  /**
   * Personal access token for the GitHub API (`GITHUB_TOKEN` env, with
   * `GH_TOKEN` as a fallback). Empty means "not configured": without an
   * authenticated gh CLI or a token the github_* tools answer with a clear
   * unavailable error per call instead of failing at startup.
   *
   * The token is a secret: it is only ever sent in an Authorization header
   * and must never be logged.
   */
  token: string;
  /**
   * REST API base URL (`GITHUB_BASE_URL` env); empty means the transport
   * default (https://api.github.com, or a GitHub Enterprise API URL).
   */
  baseUrl: string;
}

export interface AppConfig {
  embedding: EmbeddingConfigResult;
  redis: RedisConfig;
  github: GitHubConfig;
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
  GITHUB_TOKEN: z.string().optional(),
  GH_TOKEN: z.string().optional(),
  GITHUB_BASE_URL: z.string().optional(),
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
  // Only the OpenAI-compatible protocol is implemented; any other value
  // degrades the tool with a clear reason instead of a config parse error.
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
    github: {
      token: (parsed.GITHUB_TOKEN ?? parsed.GH_TOKEN ?? "").trim(),
      baseUrl: (parsed.GITHUB_BASE_URL ?? "").replace(/\/+$/, ""),
    },
    host: parsed.HOST,
    port: parsed.PORT,
  };
}
