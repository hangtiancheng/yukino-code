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

export interface MinioConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  region: string;
  sessionToken: string;
}

export interface ClickhouseConfig {
  url: string;
  username: string;
  password: string;
  database: string;
}

export interface EtcdConfig {
  url: string;
}

export interface MilvusConfig {
  url: string;
  token: string;
  database: string;
}

export interface GrafanaConfig {
  baseUrl: string;
  token: string;
  username: string;
  password: string;
}

export interface KafkaConfig {
  brokers: string;
  clientId: string;
  username: string;
  password: string;
  saslMechanism: string;
  securityProtocol: string;
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
  grafana: GrafanaConfig;
  minio: MinioConfig;
  clickhouse: ClickhouseConfig;
  etcd: EtcdConfig;
  milvus: MilvusConfig;
  kafka: KafkaConfig;
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
  GRAFANA_BASE_URL: z.string().optional(),
  GRAFANA_URL: z.string().optional(),
  GRAFANA_TOKEN: z.string().optional(),
  GRAFANA_API_KEY: z.string().optional(),
  GRAFANA_USERNAME: z.string().optional(),
  GRAFANA_PASSWORD: z.string().optional(),
  MINIO_URL: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  MINIO_ACCESS_KEY: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  MINIO_SECRET_KEY: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  MINIO_REGION: z.string().optional(),
  AWS_REGION: z.string().optional(),
  AWS_DEFAULT_REGION: z.string().optional(),
  MINIO_SESSION_TOKEN: z.string().optional(),
  AWS_SESSION_TOKEN: z.string().optional(),
  CLICKHOUSE_URL: z.string().optional(),
  CLICKHOUSE_HTTP_URL: z.string().optional(),
  CLICKHOUSE_USER: z.string().optional(),
  CLICKHOUSE_PASSWORD: z.string().optional(),
  CLICKHOUSE_DATABASE: z.string().optional(),
  ETCD_URL: z.string().optional(),
  ETCD_ENDPOINTS: z.string().optional(),
  MILVUS_URL: z.string().optional(),
  MILVUS_ADDRESS: z.string().optional(),
  MILVUS_TOKEN: z.string().optional(),
  MILVUS_USERNAME: z.string().optional(),
  MILVUS_PASSWORD: z.string().optional(),
  MILVUS_DATABASE: z.string().optional(),
  KAFKA_BROKERS: z.string().optional(),
  KAFKA_CLIENT_ID: z.string().optional(),
  KAFKA_USERNAME: z.string().optional(),
  KAFKA_PASSWORD: z.string().optional(),
  KAFKA_SASL_MECHANISM: z.string().optional(),
  KAFKA_SECURITY_PROTOCOL: z.string().optional(),
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

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeEtcdUrl(raw: string): string {
  // Compose-style endpoint such as "etcd:2379" or a comma-separated list; use
  // the first entry, preserving its scheme when supplied.
  const first = raw.split(",")[0]?.trim() ?? "";
  if (!first) return "";
  if (/^https?:\/\//i.test(first)) return stripTrailingSlashes(first);
  return stripTrailingSlashes(`http://${first}`);
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const parsed = EnvSchema.parse(dropEmptyValues(env));
  const milvusToken =
    parsed.MILVUS_TOKEN ??
    (parsed.MILVUS_USERNAME || parsed.MILVUS_PASSWORD
      ? `${parsed.MILVUS_USERNAME ?? ""}:${parsed.MILVUS_PASSWORD ?? ""}`
      : "");
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
    grafana: {
      baseUrl: (parsed.GRAFANA_BASE_URL ?? parsed.GRAFANA_URL ?? "").replace(
        /\/+$/,
        "",
      ),
      token: parsed.GRAFANA_TOKEN ?? parsed.GRAFANA_API_KEY ?? "",
      username: parsed.GRAFANA_USERNAME ?? "",
      password: parsed.GRAFANA_PASSWORD ?? "",
    },
    minio: {
      endpoint: stripTrailingSlashes(
        parsed.MINIO_URL ?? parsed.S3_ENDPOINT ?? "",
      ),
      accessKey: parsed.MINIO_ACCESS_KEY ?? parsed.AWS_ACCESS_KEY_ID ?? "",
      secretKey: parsed.MINIO_SECRET_KEY ?? parsed.AWS_SECRET_ACCESS_KEY ?? "",
      region:
        parsed.MINIO_REGION ??
        parsed.AWS_REGION ??
        parsed.AWS_DEFAULT_REGION ??
        "us-east-1",
      sessionToken:
        parsed.MINIO_SESSION_TOKEN ?? parsed.AWS_SESSION_TOKEN ?? "",
    },
    clickhouse: {
      url: stripTrailingSlashes(
        parsed.CLICKHOUSE_URL ?? parsed.CLICKHOUSE_HTTP_URL ?? "",
      ),
      username: parsed.CLICKHOUSE_USER ?? "",
      password: parsed.CLICKHOUSE_PASSWORD ?? "",
      database: parsed.CLICKHOUSE_DATABASE ?? "",
    },
    etcd: {
      url: normalizeEtcdUrl(parsed.ETCD_URL ?? parsed.ETCD_ENDPOINTS ?? ""),
    },
    milvus: {
      url: stripTrailingSlashes(
        parsed.MILVUS_URL ?? parsed.MILVUS_ADDRESS ?? "",
      ),
      token: milvusToken,
      database: parsed.MILVUS_DATABASE ?? "",
    },
    kafka: {
      brokers: parsed.KAFKA_BROKERS ?? "",
      clientId: parsed.KAFKA_CLIENT_ID ?? "yukino-mcp",
      username: parsed.KAFKA_USERNAME ?? "",
      password: parsed.KAFKA_PASSWORD ?? "",
      saslMechanism: parsed.KAFKA_SASL_MECHANISM ?? "",
      securityProtocol: parsed.KAFKA_SECURITY_PROTOCOL ?? "",
    },
    host: parsed.HOST,
    port: parsed.PORT,
  };
}
