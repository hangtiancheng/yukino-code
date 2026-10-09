// Shared fixtures for the docs RAG tests. The index is now a plain SQLite
// file, so these tests run against a real (temporary) database instead of a
// mocked external service.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { IndexConfig } from "@/shared/config.js";
import type { Embedder } from "@/tools/docs/embedder.js";
import { closeStore, openStore, type DocsContext } from "@/tools/docs/store.js";

/**
 * Deterministic bag-of-characters embedding: identical text yields an
 * identical (cosine 1) vector, which is all the retrieval tests need.
 */
export function fakeEmbedder(dim = 8): Embedder {
  const embedOne = (text: string): number[] => {
    const vector = new Array<number>(dim).fill(0.001);
    for (let i = 0; i < text.length; i++) {
      vector[text.charCodeAt(i) % dim] += 1;
    }
    return vector;
  };
  return {
    embedText: (text) => Promise.resolve(embedOne(text)),
    embedTexts: (texts) => Promise.resolve(texts.map(embedOne)),
  };
}

export interface IndexFixture {
  ctx: DocsContext;
  index: IndexConfig;
  /** Closes the handle and, when this fixture owns it, removes the directory. */
  cleanup(): void;
}

export interface FixtureOptions {
  embedder?: Embedder;
  /**
   * Reuse an existing database file. Passing the path of another live fixture
   * simulates a second server process sharing one index.
   */
  dbPath?: string;
}

export function makeIndexFixture(options: FixtureOptions = {}): IndexFixture {
  const ownsDir = options.dbPath === undefined;
  const dir = ownsDir
    ? mkdtempSync(path.join(tmpdir(), "yukino-index-test-"))
    : path.dirname(options.dbPath as string);
  const index: IndexConfig = {
    dbPath: options.dbPath ?? path.join(dir, "index.sqlite"),
  };
  return {
    index,
    ctx: {
      db: openStore(index),
      embedder: options.embedder ?? fakeEmbedder(),
      index,
      cache: null,
    },
    cleanup(): void {
      closeStore(this.ctx.db);
      if (ownsDir) {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
