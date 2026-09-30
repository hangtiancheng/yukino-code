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

describe("github config", () => {
  it("defaults to unconfigured when the environment is empty", () => {
    // Without an authenticated gh CLI or a token the github_* tools degrade
    // per call; nothing in the code points at an account by default.
    const config = loadConfig({});
    expect(config.github.token).toBe("");
    expect(config.github.baseUrl).toBe("");
  });

  it("treats empty strings as unset", () => {
    const config = loadConfig({ GITHUB_BASE_URL: "" });
    expect(config.github.baseUrl).toBe("");
  });

  it("prefers GITHUB_TOKEN over GH_TOKEN", () => {
    const config = loadConfig({ GITHUB_TOKEN: "a", GH_TOKEN: "b" });
    expect(config.github.token).toBe("a");
  });

  it("falls back to GH_TOKEN", () => {
    expect(loadConfig({ GH_TOKEN: "b" }).github.token).toBe("b");
  });

  it("treats a blank GITHUB_TOKEN as unset", () => {
    expect(loadConfig({ GITHUB_TOKEN: "   " }).github.token).toBe("");
  });

  it("strips trailing slashes from the base URL", () => {
    const config = loadConfig({
      GITHUB_BASE_URL: "https://ghe.example.com/api/v3//",
    });
    expect(config.github.baseUrl).toBe("https://ghe.example.com/api/v3");
  });
});
