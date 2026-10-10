import { homedir } from "node:os";
import path from "node:path";

import { z } from "zod";

export interface EmbeddingConfig {
  model: string;
  baseUrl: string;
  apiKey: string;
}

export type EmbeddingConfigResult =
  { ok: true; config: EmbeddingConfig } | { ok: false; reason: string };

export interface RedisConfig {
  url: string;
}

export interface IndexConfig {
  dbPath: string;
}

export interface GitHubConfig {
  token: string;
  baseUrl: string;
  hostname: string;
}

export interface AppConfig {
  embedding: EmbeddingConfigResult;
  index: IndexConfig;
  redis: RedisConfig;
  github: GitHubConfig;
  postgres: { url: string };
  mysql: { url: string };
  mongodb: { url: string; database: string };
  prometheus: {
    baseUrl: string;
    token: string;
    username: string;
    password: string;
  };
  docsDir: string;
  host: string;
  port: number;
}

const EnvSchema = z.object({
  EMBEDDING_PROTOCOL: z.string().optional(),
  EMBEDDING_MODEL: z.string().optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  EMBEDDING_BASE_URL: z.string().optional(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  YUKINO_DOCS_DIR: z
    .string()
    .default(path.resolve(homedir(), ".yukino", "docs")),
  YUKINO_INDEX_DB: z
    .string()
    .default(path.resolve(homedir(), ".yukino", "index.sqlite")),
  GITHUB_TOKEN: z.string().optional(),
  GH_TOKEN: z.string().optional(),
  GITHUB_BASE_URL: z.string().optional(),
  GH_HOST: z.string().optional(),
  POSTGRES_URL: z.string().optional(),
  POSTGRESQL_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  MYSQL_URL: z.string().optional(),
  MONGODB_URL: z.string().optional(),
  MONGODB_DATABASE: z.string().optional(),
  PROMETHEUS_BASE_URL: z.string().optional(),
  PROMETHEUS_URL: z.string().optional(),
  PROMETHEUS_TOKEN: z.string().optional(),
  PROMETHEUS_USERNAME: z.string().optional(),
  PROMETHEUS_PASSWORD: z.string().optional(),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3300).catch(3300),
});

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
    index: { dbPath: parsed.YUKINO_INDEX_DB },
    redis: { url: parsed.REDIS_URL },
    docsDir: parsed.YUKINO_DOCS_DIR,
    github: {
      token: (parsed.GITHUB_TOKEN ?? parsed.GH_TOKEN ?? "").trim(),
      baseUrl: (parsed.GITHUB_BASE_URL ?? "").replace(/\/+$/, ""),
      hostname: parsed.GH_HOST ?? "",
    },
    postgres: {
      url:
        parsed.POSTGRES_URL ??
        parsed.POSTGRESQL_URL ??
        parsed.DATABASE_URL ??
        "",
    },
    mysql: { url: parsed.MYSQL_URL ?? "" },
    mongodb: {
      url: parsed.MONGODB_URL ?? "",
      database: parsed.MONGODB_DATABASE ?? "",
    },
    prometheus: {
      baseUrl: (
        parsed.PROMETHEUS_BASE_URL ??
        parsed.PROMETHEUS_URL ??
        ""
      ).replace(/\/+$/, ""),
      token: parsed.PROMETHEUS_TOKEN ?? "",
      username: parsed.PROMETHEUS_USERNAME ?? "",
      password: parsed.PROMETHEUS_PASSWORD ?? "",
    },
    host: parsed.HOST,
    port: parsed.PORT,
  };
}
