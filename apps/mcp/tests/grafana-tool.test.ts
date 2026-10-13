import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { grafanaModule } from "@/tools/grafana/tool.js";
import { firstText, isolateEnv, stubFetchRoutes } from "./helpers.js";

const envKeys = [
  "GRAFANA_BASE_URL",
  "GRAFANA_URL",
  "GRAFANA_TOKEN",
  "GRAFANA_API_KEY",
  "GRAFANA_USERNAME",
  "GRAFANA_PASSWORD",
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
    await client.callTool({ name: "grafana_tool", arguments: args }),
  );
}

beforeEach(async () => {
  for (const key of envKeys) delete process.env[key];
  process.env["GRAFANA_BASE_URL"] = "http://localhost:3000";
  const server = new McpServer({ name: "test", version: "1" });
  grafanaModule.register(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1" });
  await Promise.all([client.connect(a), server.connect(b)]);
});

afterEach(async () => {
  await client.close();
});

describe("grafana_tool", () => {
  it("defaults to /api/health and returns parsed JSON", async () => {
    const data = { commit: "abc", database: "ok", version: "13.2.3" };
    const routes = stubFetchRoutes([
      { method: "GET", url: "http://localhost:3000/api/health", json: data },
    ]);
    const result = await call();
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ status_code: 200, data });
    expect(JSON.parse(firstText(result))).toEqual(result.structuredContent);
    expect(routes.lastCall().method).toBe("GET");
  });

  it("uses bearer authentication from GRAFANA_TOKEN", async () => {
    process.env["GRAFANA_TOKEN"] = "glsa_secret";
    const routes = stubFetchRoutes([
      { method: "GET", url: "http://localhost:3000/api/search", json: [] },
    ]);
    await call({ path: "/api/search", params: { query: "my-dashboard" } });
    expect(routes.lastCall().headers["authorization"]).toBe(
      "Bearer glsa_secret",
    );
    const url = new URL(routes.lastCall().url);
    expect(url.searchParams.get("query")).toBe("my-dashboard");
  });

  it("falls back to GRAFANA_API_KEY and to basic authentication", async () => {
    process.env["GRAFANA_API_KEY"] = "api-key";
    let routes = stubFetchRoutes([
      { method: "GET", url: "http://localhost:3000/api/org", json: {} },
    ]);
    await call({ path: "/api/org" });
    expect(routes.lastCall().headers["authorization"]).toBe("Bearer api-key");

    delete process.env["GRAFANA_API_KEY"];
    process.env["GRAFANA_USERNAME"] = "root";
    process.env["GRAFANA_PASSWORD"] = "pass";
    routes = stubFetchRoutes([
      { method: "GET", url: "http://localhost:3000/api/org", json: {} },
    ]);
    await call({ path: "/api/org" });
    expect(routes.lastCall().headers["authorization"]).toBe(
      `Basic ${Buffer.from("root:pass").toString("base64")}`,
    );
  });

  it("POSTs a dashboard model as JSON", async () => {
    const routes = stubFetchRoutes([
      {
        method: "POST",
        url: "http://localhost:3000/api/dashboards/db",
        json: { id: 1, uid: "abc123", status: "success" },
      },
    ]);
    const body = { dashboard: { title: "Demo", panels: [] }, overwrite: true };
    const result = await call({
      path: "/api/dashboards/db",
      method: "POST",
      body,
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(routes.lastCall().body ?? "")).toEqual(body);
    expect(routes.lastCall().headers["content-type"]).toBe("application/json");
  });

  it("runs a proxied datasource query and sends custom headers", async () => {
    const routes = stubFetchRoutes([
      {
        method: "POST",
        url: "http://localhost:3000/api/ds/query",
        json: { results: {} },
      },
    ]);
    await call({
      path: "/api/ds/query",
      method: "POST",
      headers: { "x-grafana-org-id": "2", authorization: "Bearer override" },
      body: { queries: [{ refId: "A", datasource: { uid: "prometheus" } }] },
    });
    expect(routes.lastCall().headers["x-grafana-org-id"]).toBe("2");
    expect(routes.lastCall().headers["authorization"]).toBe("Bearer override");
  });

  it("accepts absolute URLs and non-JSON responses", async () => {
    stubFetchRoutes([
      {
        method: "GET",
        url: "https://grafana.example.com/api/health",
        text: "ok",
      },
    ]);
    const result = await call({
      path: "https://grafana.example.com/api/health",
    });
    expect(result.structuredContent).toEqual({ status_code: 200, data: "ok" });
  });

  it("flags HTTP errors and retains the response body", async () => {
    const data = { message: "dashboard not found" };
    stubFetchRoutes([
      {
        method: "GET",
        url: "http://localhost:3000/api/dashboards/uid/missing",
        status: 404,
        json: data,
      },
    ]);
    const result = await call({ path: "/api/dashboards/uid/missing" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ status_code: 404, data });
  });

  it("lists the tool without configuration and reports how to configure it", async () => {
    delete process.env["GRAFANA_BASE_URL"];
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "grafana_tool",
    ]);
    const result = await call();
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("GRAFANA_BASE_URL");
  });
});
