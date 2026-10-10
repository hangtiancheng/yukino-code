import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { IndexConfig } from "@/shared/config.js";
import type { Embedder } from "@/tools/docs/embedder.js";
import { closeStore, openStore, type DocsContext } from "@/tools/docs/store.js";

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
  cleanup(): void;
}

export interface FixtureOptions {
  embedder?: Embedder;
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
