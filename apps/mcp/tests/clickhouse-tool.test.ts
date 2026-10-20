import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { firstText, isolateEnv, stubFetchRoutes } from "./helpers.js";

import { clickhouseModule } from "@/tools/clickhouse/tool.js";

const envKeys = [
  "CLICKHOUSE_URL",
  "CLICKHOUSE_HTTP_URL",
  "CLICKHOUSE_USER",
  "CLICKHOUSE_PASSWORD",
  "CLICKHOUSE_DATABASE",
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
    await client.callTool({ name: "clickhouse_tool", arguments: args }),
  );
}

beforeEach(async () => {
  for (const key of envKeys) {
    Reflect.deleteProperty(process.env, key);
  }
  process.env["CLICKHOUSE_URL"] = "http://localhost:8123";
  process.env["CLICKHOUSE_USER"] = "langfuse";
  process.env["CLICKHOUSE_PASSWORD"] = "secret";
  process.env["CLICKHOUSE_DATABASE"] = "default";
  const server = new McpServer({ name: "test", version: "1" });
  clickhouseModule.register(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1" });
  await Promise.all([client.connect(a), server.connect(b)]);
});

afterEach(async () => {
  await client.close();
});

describe("clickhouse_tool", () => {
  it("sends the configured user with X-ClickHouse-Key", async () => {
    const routes = stubFetchRoutes([
      { method: "POST", url: "http://localhost:8123/", json: { data: [] } },
    ]);
    const result = await call({ sql: "SELECT 1", api_key: "override" });
    expect(result.isError).toBeUndefined();
    expect(routes.lastCall().headers["x-clickhouse-user"]).toBe("langfuse");
    expect(routes.lastCall().headers["x-clickhouse-key"]).toBe("override");
    expect(routes.lastCall().headers["authorization"]).toBeUndefined();
  });
  it("runs a SELECT and parses the JSON result", async () => {
    const payload = { meta: [], data: [{ n: 1 }], rows: 1 };
    const routes = stubFetchRoutes([
      { method: "POST", url: "http://localhost:8123/", json: payload },
    ]);
    const result = await call({ sql: "SELECT 1 AS n" });
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent!;
    expect(sc["status_code"]).toBe(200);
    expect(sc["format"]).toBe("JSON");
    expect(sc["data"]).toEqual(payload);
    const last = routes.lastCall();
    expect(last.body).toBe("SELECT 1 AS n");
    expect(last.headers["content-type"]).toContain("text/plain");
    const url = new URL(last.url);
    // Credentials travel only in the Authorization header; a `user` query
    // parameter alongside basic auth makes ClickHouse fail authentication.
    expect(url.searchParams.get("user")).toBeNull();
    expect(url.searchParams.get("database")).toBe("default");
    expect(url.searchParams.get("default_format")).toBe("JSON");
    expect(last.headers["authorization"]).toBe(
      `Basic ${Buffer.from("langfuse:secret").toString("base64")}`,
    );
  });

  it("maps params to param_ settings and passes engine settings", async () => {
    const routes = stubFetchRoutes([
      { method: "POST", url: "http://localhost:8123/", json: { data: [] } },
    ]);
    await call({
      sql: "SELECT {id:UInt64}",
      params: { id: 42 },
      settings: { max_execution_time: 5, readonly: 1 },
    });
    const url = new URL(routes.lastCall().url);
    expect(url.searchParams.get("param_id")).toBe("42");
    expect(url.searchParams.get("max_execution_time")).toBe("5");
    expect(url.searchParams.get("readonly")).toBe("1");
  });

  it("sends INSERT data as the body with the query as a parameter", async () => {
    const routes = stubFetchRoutes([
      { method: "POST", url: "http://localhost:8123/", text: "" },
    ]);
    const result = await call({
      sql: "INSERT INTO t FORMAT JSONEachRow",
      data: '{"a":1}\n{"a":2}\n',
      format: "JSONEachRow",
    });
    expect(result.isError).toBeUndefined();
    const last = routes.lastCall();
    const url = new URL(last.url);
    expect(url.searchParams.get("query")).toBe(
      "INSERT INTO t FORMAT JSONEachRow",
    );
    expect(url.searchParams.get("default_format")).toBe("JSONEachRow");
    expect(last.body).toBe('{"a":1}\n{"a":2}\n');
  });

  it("returns text for non-JSON formats", async () => {
    stubFetchRoutes([
      { method: "POST", url: "http://localhost:8123/", text: "1,2\n3,4\n" },
    ]);
    const result = await call({ sql: "SELECT 1", format: "CSV" });
    const sc = result.structuredContent!;
    expect(sc["format"]).toBe("CSV");
    expect(sc["data"]).toBe("1,2\n3,4\n");
  });

  it("flags server errors and keeps the response body", async () => {
    stubFetchRoutes([
      {
        method: "POST",
        url: "http://localhost:8123/",
        status: 500,
        text: "Code: 62. DB::Exception: Syntax error",
      },
    ]);
    const result = await call({ sql: "SELEC 1" });
    expect(result.isError).toBe(true);
    const sc = result.structuredContent!;
    expect(sc["status_code"]).toBe(500);
    expect(String(sc["data"])).toContain("DB::Exception");
  });

  it("reports a missing connection as an error", async () => {
    delete process.env["CLICKHOUSE_URL"];
    const result = await call({ sql: "SELECT 1" });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("CLICKHOUSE_URL");
  });
});
