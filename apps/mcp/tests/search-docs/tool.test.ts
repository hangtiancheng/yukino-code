import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const storeState = vi.hoisted(() => ({
  db: null as FakeDb | null,
  openCalls: 0,
}));

interface FakeStatement {
  get: () => undefined;
  all: () => unknown[];
  run: () => { changes: number };
}

interface FakeDb {
  isOpen: boolean;
  prepare: (sql: string) => FakeStatement;
}

function makeFakeDb(): FakeDb {
  return {
    isOpen: true,
    prepare() {
      if (!storeState.db?.isOpen) {
        throw new Error("database is closed");
      }
      return {
        get: () => undefined,
        all: () => [],
        run: () => ({ changes: 0 }),
      };
    },
  };
}

vi.mock("@/tools/docs/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/tools/docs/store.js")>();
  return {
    ...actual,
    openStore: vi.fn(() => {
      storeState.openCalls++;
      return storeState.db;
    }),
    ensureSchema: vi.fn(async () => undefined),
    closeStore: vi.fn(() => undefined),
  };
});

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
    await client.callTool({
      name: "docs_tool",
      arguments: { query: "test query" },
    }),
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
    vi.useFakeTimers({ toFake: ["Date"] });
    storeState.db = makeFakeDb();
    client = await connect();
  });

  afterAll(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await client?.close();
  });

  it("serves queries while the index is healthy", async () => {
    const result = await queryDocs(client);
    expect(result.isError).toBe(false);
    expect(result.text).toContain("No matching documents");
    expect(storeState.openCalls).toBe(1);
  });

  it("degrades when the index handle dies mid-session", async () => {
    storeState.db!.isOpen = false;

    const failed = await queryDocs(client);
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("docs failed: database is closed");

    const degraded = await queryDocs(client);
    expect(degraded.isError).toBe(true);
    expect(degraded.text).toContain("docs is unavailable");
    expect(degraded.text).toContain("vector index connection lost");
  });

  it("re-initializes once the degraded retry window has passed", async () => {
    storeState.db = makeFakeDb();
    vi.setSystemTime(Date.now() + 31_000);

    const result = await queryDocs(client);
    expect(result.isError).toBe(false);
    expect(result.text).toContain("No matching documents");
    expect(storeState.openCalls).toBe(2);
  });
});
