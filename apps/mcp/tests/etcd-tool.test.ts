import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { firstText, isolateEnv, stubFetchRoutes } from "./helpers.js";

import { decodeResponseBytes, encodeRequestBytes } from "@/tools/etcd/codec.js";
import { etcdModule } from "@/tools/etcd/tool.js";

const envKeys = ["ETCD_URL", "ETCD_ENDPOINTS"];
isolateEnv(envKeys);

const resultSchema = z.object({
  content: z.array(z.unknown()),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});

let client: Client;
async function call(args: Record<string, unknown> = {}) {
  return resultSchema.parse(
    await client.callTool({ name: "etcd_tool", arguments: args }),
  );
}

beforeEach(async () => {
  for (const key of envKeys) {
    delete process.env[key];
  }
  process.env["ETCD_URL"] = "http://localhost:2379";
  const server = new McpServer({ name: "test", version: "1" });
  etcdModule.register(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1" });
  await Promise.all([client.connect(a), server.connect(b)]);
});

afterEach(async () => {
  await client.close();
});

describe("etcd base64 codec", () => {
  it("encodes key/range_end/value fields recursively", () => {
    const body = {
      key: "a",
      range_end: "b",
      value: "v",
      lease: "123",
      compare: [{ key: "a", value: "x", result: "EQUAL" }],
      success: [
        { request_put: { key: "a", value: "y" } },
        { request_range: { key: "a", range_end: "b" } },
      ],
    };
    expect(encodeRequestBytes(body)).toEqual({
      key: Buffer.from("a").toString("base64"),
      range_end: Buffer.from("b").toString("base64"),
      value: Buffer.from("v").toString("base64"),
      lease: "123",
      compare: [
        {
          key: Buffer.from("a").toString("base64"),
          value: Buffer.from("x").toString("base64"),
          result: "EQUAL",
        },
      ],
      success: [
        {
          request_put: {
            key: Buffer.from("a").toString("base64"),
            value: Buffer.from("y").toString("base64"),
          },
        },
        {
          request_range: {
            key: Buffer.from("a").toString("base64"),
            range_end: Buffer.from("b").toString("base64"),
          },
        },
      ],
    });
  });

  it("decodes response key/value fields to UTF-8 when possible", () => {
    const data = {
      header: { revision: "5" },
      kvs: [
        {
          key: Buffer.from("greeting").toString("base64"),
          value: Buffer.from("hello").toString("base64"),
          create_revision: "2",
        },
        {
          key: Buffer.from("bin").toString("base64"),
          // 0xff is not valid UTF-8, so it must remain base64.
          value: Buffer.from([0xff, 0xfe]).toString("base64"),
        },
      ],
    };
    const decoded = decodeResponseBytes(data) as {
      kvs: { key: string; value: string }[];
    };
    expect(decoded.kvs[0].key).toBe("greeting");
    expect(decoded.kvs[0].value).toBe("hello");
    expect(decoded.kvs[1].key).toBe("bin");
    expect(decoded.kvs[1].value).toBe(
      Buffer.from([0xff, 0xfe]).toString("base64"),
    );
  });
});

describe("etcd_tool", () => {
  it("puts a key/value and base64-encodes the request", async () => {
    const routes = stubFetchRoutes([
      {
        method: "POST",
        url: "http://localhost:2379/v3/kv/put",
        json: { header: {} },
      },
    ]);
    const result = await call({
      path: "/v3/kv/put",
      body: { key: "app/name", value: "yukino" },
    });
    expect(result.isError).toBeUndefined();
    const sent = JSON.parse(routes.lastCall().body ?? "{}");
    expect(sent.key).toBe(Buffer.from("app/name").toString("base64"));
    expect(sent.value).toBe(Buffer.from("yukino").toString("base64"));
    expect(routes.lastCall().headers["content-type"]).toContain(
      "application/json",
    );
  });

  it("reads a range and decodes returned keys/values", async () => {
    stubFetchRoutes([
      {
        method: "POST",
        url: "http://localhost:2379/v3/kv/range",
        json: {
          header: { revision: "9" },
          count: "1",
          kvs: [
            {
              key: Buffer.from("app/name").toString("base64"),
              value: Buffer.from("yukino").toString("base64"),
            },
          ],
        },
      },
    ]);
    const result = await call({ body: { key: "app/name" } });
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent!;
    const data = sc["data"] as { kvs: { key: string; value: string }[] };
    expect(data.kvs[0].key).toBe("app/name");
    expect(data.kvs[0].value).toBe("yukino");
  });

  it("supports raw_base64 passthrough and auth headers", async () => {
    const routes = stubFetchRoutes([
      {
        method: "POST",
        url: "http://localhost:2379/v3/kv/put",
        json: { header: {} },
      },
    ]);
    const b64 = Buffer.from("raw").toString("base64");
    await call({
      path: "/v3/kv/put",
      body: { key: b64, value: b64 },
      raw_base64: true,
      headers: { authorization: "token-abc" },
    });
    const sent = JSON.parse(routes.lastCall().body ?? "{}");
    expect(sent.key).toBe(b64);
    expect(sent.value).toBe(b64);
    expect(routes.lastCall().headers["authorization"]).toBe("token-abc");
  });

  it("flags gateway errors", async () => {
    stubFetchRoutes([
      {
        method: "POST",
        url: "http://localhost:2379/v3/kv/range",
        status: 400,
        json: { error: "etcdserver: key not provided", code: 3 },
      },
    ]);
    const result = await call({ body: {} });
    expect(result.isError).toBe(true);
    const sc = result.structuredContent!;
    expect(sc["status_code"]).toBe(400);
  });

  it("normalizes compose-style endpoints and reports missing config", async () => {
    delete process.env["ETCD_URL"];
    process.env["ETCD_ENDPOINTS"] = "etcd:2379";
    const routes = stubFetchRoutes([
      {
        method: "POST",
        url: "http://etcd:2379/v3/maintenance/status",
        json: {},
      },
    ]);
    const result = await call({ path: "/v3/maintenance/status" });
    expect(result.isError).toBeUndefined();
    expect(routes.lastCall().baseUrl).toBe(
      "http://etcd:2379/v3/maintenance/status",
    );

    delete process.env["ETCD_ENDPOINTS"];
    const missing = await call({ path: "/v3/kv/range" });
    expect(missing.isError).toBe(true);
    expect(firstText(missing)).toContain("ETCD_URL");
  });
});
