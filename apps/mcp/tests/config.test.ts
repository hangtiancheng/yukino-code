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

import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "@/shared/config.js";

describe("loadConfig", () => {
  it("applies defaults when env is empty", () => {
    const config = loadConfig({});
    expect(config.redis).toEqual({
      url: "redis://localhost:6379",
      indexName: "idx:yukino",
      keyPrefix: "yukino:",
    });
    expect(config.docsDir).toBe(path.join(os.homedir(), ".yukino", "docs"));
    expect(config.port).toBe(3300);
    expect(config.embedding.ok).toBe(false);
  });

  it("reports every missing embedding variable", () => {
    const config = loadConfig({ EMBEDDING_MODEL: "m" });
    expect(config.embedding.ok).toBe(false);
    if (!config.embedding.ok) {
      expect(config.embedding.reason).toContain("EMBEDDING_BASE_URL");
      expect(config.embedding.reason).toContain("EMBEDDING_API_KEY");
      expect(config.embedding.reason).not.toContain("EMBEDDING_MODEL");
    }
  });

  it("builds the embedding config when fully specified", () => {
    const config = loadConfig({
      EMBEDDING_MODEL: "text-embedding-v4",
      EMBEDDING_BASE_URL: "https://example.com/v1",
      EMBEDDING_API_KEY: "sk-1",
    });
    expect(config.embedding).toEqual({
      ok: true,
      config: {
        model: "text-embedding-v4",
        baseUrl: "https://example.com/v1",
        apiKey: "sk-1",
      },
    });
  });

  it("rejects unsupported embedding protocols", () => {
    const config = loadConfig({
      EMBEDDING_PROTOCOL: "ollama",
      EMBEDDING_MODEL: "m",
      EMBEDDING_BASE_URL: "https://example.com/v1",
      EMBEDDING_API_KEY: "sk-1",
    });
    expect(config.embedding.ok).toBe(false);
    if (!config.embedding.ok) {
      expect(config.embedding.reason).toContain('"ollama"');
    }
  });

  it("accepts an explicit openai protocol", () => {
    const config = loadConfig({
      EMBEDDING_PROTOCOL: "openai",
      EMBEDDING_MODEL: "m",
      EMBEDDING_BASE_URL: "https://example.com/v1",
      EMBEDDING_API_KEY: "sk-1",
    });
    expect(config.embedding.ok).toBe(true);
  });

  it("falls back to OPENAI_API_KEY when EMBEDDING_API_KEY is unset", () => {
    const config = loadConfig({
      EMBEDDING_MODEL: "m",
      EMBEDDING_BASE_URL: "https://example.com/v1",
      OPENAI_API_KEY: "sk-openai",
    });
    expect(config.embedding).toEqual({
      ok: true,
      config: {
        model: "m",
        baseUrl: "https://example.com/v1",
        apiKey: "sk-openai",
      },
    });
  });

  it("treats empty strings as unset", () => {
    const config = loadConfig({
      EMBEDDING_MODEL: "  ",
      REDIS_URL: "",
      PORT: "",
    });
    expect(config.redis.url).toBe("redis://localhost:6379");
    expect(config.port).toBe(3300);
    expect(config.embedding.ok).toBe(false);
  });

  it("coerces PORT and honors overrides", () => {
    const config = loadConfig({
      PORT: "8080",
      YUKINO_DOCS_DIR: "/tmp/kb",
      REDIS_INDEX_NAME: "idx:custom",
      REDIS_KEY_PREFIX: "custom:",
    });
    expect(config.port).toBe(8080);
    expect(config.docsDir).toBe("/tmp/kb");
    expect(config.redis.indexName).toBe("idx:custom");
    expect(config.redis.keyPrefix).toBe("custom:");
  });
});
