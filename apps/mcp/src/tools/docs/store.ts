import { mkdirSync } from "node:fs";
import { createRequire as nodeCreateRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync as Database } from "node:sqlite";

import type { IndexConfig } from "@/shared/config.js";
import { logger } from "@/shared/logger.js";
import type { Embedder } from "./embedder.js";

const BUSY_TIMEOUT_MS = 5_000;

const SCHEMA_VERSION = "1";

const SQLITE_BUSY = 5;

export interface VectorCache {
  dataVersion: number;
  dim: number;
  ids: string[];
  matrix: Float32Array;
}

const nodeRequire = nodeCreateRequire(import.meta.url);

function loadSqlite(): typeof import("node:sqlite") {
  return nodeRequire("node:sqlite") as typeof import("node:sqlite");
}

export interface DocsContext {
  db: Database;
  embedder: Embedder;
  index: IndexConfig;
  cache: VectorCache | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sources (
  source TEXT PRIMARY KEY,
  hash   TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS chunks (
  id         TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  content    TEXT NOT NULL,
  metadata   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  vector     BLOB NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS chunks_source_idx ON chunks(source);
`;

export function isBusyError(err: unknown): boolean {
  return (
    err instanceof Error &&
    "errcode" in err &&
    (err as { errcode?: unknown }).errcode === SQLITE_BUSY
  );
}

export function currentDataVersion(db: Database): number {
  const row = db.prepare("PRAGMA data_version").get() as
    { data_version?: unknown } | undefined;
  const value = Number(row?.data_version ?? Number.NaN);
  return Number.isFinite(value) ? value : 0;
}

export function readMeta(db: Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    { value?: unknown } | undefined;
  return typeof row?.value === "string" ? row.value : null;
}

export function writeMeta(db: Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES(?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function invalidateCache(ctx: DocsContext): void {
  ctx.cache = null;
}

export function openStore(index: IndexConfig): Database {
  if (index.dbPath !== ":memory:") {
    mkdirSync(path.dirname(index.dbPath), { recursive: true });
  }
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(index.dbPath, { timeout: BUSY_TIMEOUT_MS });
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec(SCHEMA);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

export function closeStore(db: Database): void {
  try {
    db.close();
  } catch {}
}

export async function ensureSchema(ctx: DocsContext): Promise<void> {
  const dim = (await ctx.embedder.embedText("dimension probe")).length;
  if (dim === 0) {
    throw new Error("Embedding provider returned an empty vector.");
  }

  const storedVersion = readMeta(ctx.db, "schema_version");
  const storedDim = readMeta(ctx.db, "dim");
  if (storedVersion === SCHEMA_VERSION && storedDim === String(dim)) {
    return;
  }

  if (storedVersion === SCHEMA_VERSION && storedDim !== null) {
    logger.warn(
      { storedDim, dim },
      "index dimension mismatch, wiping and rebuilding the index",
    );
  }
  ctx.db.exec("DELETE FROM chunks");
  ctx.db.exec("DELETE FROM sources");
  writeMeta(ctx.db, "schema_version", SCHEMA_VERSION);
  writeMeta(ctx.db, "dim", String(dim));
  invalidateCache(ctx);
  logger.info({ dim, path: ctx.index.dbPath }, "vector index created");
}
