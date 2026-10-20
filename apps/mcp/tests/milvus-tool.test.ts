import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { firstText, isolateEnv, stubFetchRoutes } from "./helpers.js";

import { milvusModule } from "@/tools/milvus/tool.js";

const envKeys = [
  "MILVUS_URL",
  "MILVUS_ADDRESS",
  "MILVUS_TOKEN",
  "MILVUS_USERNAME",
  "MILVUS_PASSWORD",
  "MILVUS_DATABASE",
];
isolateEnv(envKeys);

const resultSchema = z.object({
  content: z.array(z.unknown()),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});

let client: Client;
async function call(args: Record<string, unknown> = {}) {
  return resultSchema.parse(
    await client.callTool({ name: "milvus_tool", arguments: args }),
  );
}

beforeEach(async () => {
  for (const key of envKeys) {
    Reflect.deleteProperty(process.env, key);
  }
  process.env["MILVUS_URL"] = "http://localhost:19530";
  process.env["MILVUS_USERNAME"] = "root";
  process.env["MILVUS_PASSWORD"] = "milvus";
  const server = new McpServer({ name: "test", version: "1" });
  milvusModule.register(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1" });
  await Promise.all([client.connect(a), server.connect(b)]);
});

afterEach(async () => {
  await client.close();
});

describe("milvus_tool", () => {
  it("lists collections with bearer auth from username:password", async () => {
    const routes = stubFetchRoutes([
      {
        method: "POST",
        url: "http://localhost:19530/v2/vectordb/collections/list",
        json: { code: 0, data: [] },
      },
    ]);
    const result = await call();
    expect(result.isError).toBeUndefined();
    const last = routes.lastCall();
    expect(last.headers["authorization"]).toBe("Bearer root:milvus");
    expect(last.headers["content-type"]).toContain("application/json");
    const sc = result.structuredContent!;
    expect(sc["status_code"]).toBe(200);
    expect(sc["data"]).toEqual({ code: 0, data: [] });
  });

  it("injects dbName from the database argument", async () => {
    const routes = stubFetchRoutes([
      {
        method: "POST",
        url: "http://localhost:19530/v2/vectordb/collections/create",
        json: { code: 0, data: {} },
      },
    ]);
    await call({
      path: "/v2/vectordb/collections/create",
      database: "analytics",
      body: { collectionName: "docs" },
    });
    const sent = JSON.parse(routes.lastCall().body ?? "{}");
    expect(sent).toEqual({ collectionName: "docs", dbName: "analytics" });
  });

  it("does not override an explicit dbName and honours token override", async () => {
    const routes = stubFetchRoutes([
      {
        method: "POST",
        url: "http://localhost:19530/v2/vectordb/entities/query",
        json: { code: 0, data: [] },
      },
    ]);
    await call({
      path: "/v2/vectordb/entities/query",
      database: "ignored",
      token: "api-key-123",
      body: { collectionName: "docs", dbName: "explicit", filter: "id > 0" },
    });
    const sent = JSON.parse(routes.lastCall().body ?? "{}");
    expect(sent.dbName).toBe("explicit");
    expect(routes.lastCall().headers["authorization"]).toBe(
      "Bearer api-key-123",
    );
  });

  it("flags a non-zero Milvus code as an error", async () => {
    stubFetchRoutes([
      {
        method: "POST",
        url: "http://localhost:19530/v2/vectordb/collections/describe",
        json: { code: 100, message: "collection not found" },
      },
    ]);
    const result = await call({
      path: "/v2/vectordb/collections/describe",
      body: { collectionName: "missing" },
    });
    expect(result.isError).toBe(true);
    const sc = result.structuredContent!;
    expect((sc["data"] as { code: number }).code).toBe(100);
  });

  it("reports a missing connection as an error", async () => {
    delete process.env["MILVUS_URL"];
    const result = await call();
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("MILVUS_URL");
  });
});
