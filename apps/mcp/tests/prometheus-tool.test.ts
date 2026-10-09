import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { prometheusModule } from "@/tools/prometheus/tool.js";
import { firstText, isolateEnv, stubFetchRoutes } from "./helpers.js";

const envKeys = [
  "PROMETHEUS_BASE_URL",
  "PROMETHEUS_URL",
  "PROMETHEUS_TOKEN",
  "PROMETHEUS_USERNAME",
  "PROMETHEUS_PASSWORD",
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
    await client.callTool({ name: "prometheus_tool", arguments: args }),
  );
}
beforeEach(async () => {
  for (const key of envKeys) delete process.env[key];
  const server = new McpServer({ name: "test", version: "1" });
  prometheusModule.register(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1" });
  await Promise.all([client.connect(a), server.connect(b)]);
});
afterEach(async () => {
  await client.close();
});

describe("Prometheus tool", () => {
  it("defaults to alerts and retains distinct instances with the same alert name", async () => {
    process.env["PROMETHEUS_BASE_URL"] =
      "https://metrics.example.com/prometheus/";
    const alerts = [
      { labels: { alertname: "HighCPU", instance: "a" } },
      { labels: { alertname: "HighCPU", instance: "b" } },
    ];
    const data = { status: "success", data: { alerts } };
    const routes = stubFetchRoutes([
      {
        method: "GET",
        url: "https://metrics.example.com/prometheus/api/v1/alerts",
        json: data,
      },
    ]);
    const result = await call();
    expect(result.structuredContent).toEqual({ status_code: 200, data });
    expect(JSON.parse(firstText(result))).toEqual(result.structuredContent);
    expect(routes.lastCall().method).toBe("GET");
  });

  it("encodes range queries, repeated series matchers and bearer authentication", async () => {
    process.env["PROMETHEUS_TOKEN"] = "test-token";
    const routes = stubFetchRoutes([
      {
        method: "GET",
        url: "http://localhost:9090/api/v1/query_range",
        json: {
          status: "success",
          data: { resultType: "matrix", result: [] },
          warnings: ["warning"],
        },
      },
    ]);
    const result = await call({
      base_url: "http://localhost:9090",
      path: "/api/v1/query_range",
      params: {
        query: 'rate(http_requests_total{job="api"}[5m])',
        start: 1700000000,
        end: 1700000600,
        step: "15s",
        "match[]": ["up", "process_cpu_seconds_total"],
      },
    });
    expect(result.isError).toBeUndefined();
    expect(routes.lastCall().headers["authorization"]).toBe(
      "Bearer test-token",
    );
    const url = new URL(routes.lastCall().url);
    expect(url.searchParams.getAll("match[]")).toEqual([
      "up",
      "process_cpu_seconds_total",
    ]);
    expect(url.searchParams.get("query")).toBe(
      'rate(http_requests_total{job="api"}[5m])',
    );
    expect(url.searchParams.get("start")).toBe("1700000000");
  });

  it("supports destructive admin endpoints, raw form bodies and custom authentication", async () => {
    process.env["PROMETHEUS_BASE_URL"] = "http://localhost:9090";
    process.env["PROMETHEUS_TOKEN"] = "configured-token";
    const routes = stubFetchRoutes([
      {
        method: "POST",
        url: "http://localhost:9090/api/v1/admin/tsdb/delete_series",
        json: { status: "success" },
      },
    ]);
    const body = "match%5B%5D=up&start=0&end=100";
    const result = await call({
      method: "POST",
      path: "/api/v1/admin/tsdb/delete_series",
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: "Bearer override",
      },
    });
    expect(result.isError).toBeUndefined();
    expect(routes.lastCall().body).toBe(body);
    expect(routes.lastCall().headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(routes.lastCall().headers["authorization"]).toBe("Bearer override");
  });

  it("sends JSON including null, false and empty arrays using basic authentication", async () => {
    process.env["PROMETHEUS_USERNAME"] = "user";
    process.env["PROMETHEUS_PASSWORD"] = "password";
    const routes = stubFetchRoutes([
      { method: "PATCH", url: "https://metrics.example.com/custom", json: {} },
    ]);
    const body = { value: null, enabled: false, matchers: [] };
    await call({
      base_url: "https://metrics.example.com",
      path: "/custom",
      method: "PATCH",
      body,
    });
    expect(JSON.parse(routes.lastCall().body ?? "")).toEqual(body);
    expect(routes.lastCall().headers["content-type"]).toBe("application/json");
    expect(routes.lastCall().headers["authorization"]).toBe(
      `Basic ${Buffer.from("user:password").toString("base64")}`,
    );
  });

  it("accepts absolute endpoints and non-JSON management responses", async () => {
    stubFetchRoutes([
      {
        method: "POST",
        url: "http://localhost:9090/-/reload",
        text: "Reloaded",
      },
    ]);
    const result = await call({
      path: "http://localhost:9090/-/reload",
      method: "POST",
    });
    expect(result.structuredContent).toEqual({
      status_code: 200,
      data: "Reloaded",
    });
  });

  it.each([400, 200])(
    "reports Prometheus API errors at HTTP %s and retains the response",
    async (status) => {
      const data = {
        status: "error",
        errorType: "bad_data",
        error: "invalid query",
      };
      stubFetchRoutes([
        {
          method: "GET",
          url: "http://localhost:9090/api/v1/query",
          status,
          json: data,
        },
      ]);
      const result = await call({
        base_url: "http://localhost:9090",
        path: "/api/v1/query",
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({ status_code: status, data });
    },
  );

  it("reports plain HTTP failures and empty successful responses", async () => {
    stubFetchRoutes([
      {
        method: "GET",
        url: "http://localhost:9090/api/v1/alerts",
        status: 503,
        text: "upstream unavailable",
      },
      { method: "POST", url: "http://localhost:9090/-/reload", status: 204 },
    ]);
    expect((await call({ base_url: "http://localhost:9090" })).isError).toBe(
      true,
    );
    expect(
      (
        await call({
          base_url: "http://localhost:9090",
          path: "/-/reload",
          method: "POST",
        })
      ).structuredContent,
    ).toEqual({ status_code: 204, data: "" });
  });

  it("uses the requested timeout and reports network errors", async () => {
    const fetch = vi.fn(async (_url: URL, options: RequestInit) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      throw new Error("network timeout");
    });
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", fetch);
    const result = await call({
      base_url: "http://localhost:9090",
      timeout_ms: 5,
    });
    expect(timeout).toHaveBeenCalledWith(5);
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("network timeout");
    timeout.mockRestore();
  });

  it("lists the tool without configuration and reports how to configure it", async () => {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "prometheus_tool",
    ]);
    const result = await call();
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("PROMETHEUS_BASE_URL");
  });
});
