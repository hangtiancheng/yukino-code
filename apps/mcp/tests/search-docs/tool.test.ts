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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Mutable state shared with the mocked modules (vi.mock factories are hoisted).
const redisState = vi.hoisted(() => ({
  client: null as FakeClient | null,
  connectCalls: 0,
}));

interface FakeClient {
  isOpen: boolean;
  ft: {
    search: (
      ...args: unknown[]
    ) => Promise<{ total: number; documents: unknown[] }>;
  };
}

function makeFakeClient(): FakeClient {
  return {
    isOpen: true,
    ft: {
      search: async () => {
        if (!redisState.client?.isOpen) {
          throw new Error("Socket closed");
        }
        return { total: 0, documents: [] };
      },
    },
  };
}

vi.mock("@/tools/docs/redis-client.js", () => ({
  connectRedis: vi.fn(async () => {
    redisState.connectCalls++;
    return redisState.client;
  }),
  ensureIndex: vi.fn(async () => undefined),
  closeRedis: vi.fn(async () => undefined),
}));

vi.mock("@/tools/docs/embedder.js", () => ({
  createEmbedder: () => ({
    embedText: async () => [0.1, 0.2],
    embedTexts: async (texts: string[]) => texts.map(() => [0.1, 0.2]),
  }),
}));

vi.mock("@/tools/docs/pipeline.js", () => ({
  syncDocs: vi.fn(async () => ({
    indexed: 0,
    skipped: 0,
    removed: 0,
    failed: 0,
    chunks: 0,
  })),
}));

import { docsModule } from "@/tools/docs/tool.js";

const CallToolResultSchema = z.looseObject({
  isError: z.boolean().optional(),
  content: z.array(
    z.looseObject({ type: z.string(), text: z.string().optional() }),
  ),
});

async function connect(): Promise<Client> {
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  docsModule.register(server);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(clientTransport);
  await client.connect(serverTransport);
  return client;
}

async function queryDocs(
  client: Client,
): Promise<{ text: string; isError: boolean }> {
  const result = CallToolResultSchema.parse(
    await client.callTool({ name: "docs", arguments: { query: "test query" } }),
  );
  return {
    text: result.content[0]?.text ?? "",
    isError: result.isError === true,
  };
}

describe("docs engine recovery", () => {
  let client: Client;

  beforeAll(async () => {
    vi.stubEnv("EMBEDDING_MODEL", "test-model");
    vi.stubEnv("EMBEDDING_BASE_URL", "https://example.com/v1");
    vi.stubEnv("EMBEDDING_API_KEY", "sk-test");
    // Fake only Date so the 30s degraded-retry window can be fast-forwarded
    // without disturbing real timers (InMemoryTransport, withTimeout).
    vi.useFakeTimers({ toFake: ["Date"] });
    redisState.client = makeFakeClient();
    client = await connect();
  });

  afterAll(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await client?.close();
  });

  it("serves queries while redis is healthy", async () => {
    const result = await queryDocs(client);
    expect(result.isError).toBe(false);
    expect(result.text).toContain("No matching documents");
    expect(redisState.connectCalls).toBe(1);
  });

  // Regression test: a ready engine whose Redis connection died used to stay
  // "ready" forever — every query failed and the engine never re-initialized.
  it("degrades when the redis connection dies mid-session", async () => {
    redisState.client!.isOpen = false;

    const failed = await queryDocs(client);
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("docs failed: Socket closed");

    // The engine is now degraded: the next call reports unavailability
    // instead of hammering the dead connection.
    const degraded = await queryDocs(client);
    expect(degraded.isError).toBe(true);
    expect(degraded.text).toContain("docs is unavailable");
    expect(degraded.text).toContain("redis connection lost");
  });

  it("re-initializes once the degraded retry window has passed", async () => {
    // Redis comes back and the retry window (30s) elapses.
    redisState.client = makeFakeClient();
    vi.setSystemTime(Date.now() + 31_000);

    const result = await queryDocs(client);
    expect(result.isError).toBe(false);
    expect(result.text).toContain("No matching documents");
    expect(redisState.connectCalls).toBe(2);
  });
});
