import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { startHttpServer, type HttpServerHandle } from "@/http.js";
import { SERVER_NAME } from "@/server.js";

const INITIALIZE_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "vitest", version: "0.0.0" },
  },
};

const STREAMABLE_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
};

let handle: HttpServerHandle;

beforeAll(async () => {
  handle = await startHttpServer("127.0.0.1", 0);
}, 30_000);

afterAll(async () => {
  await handle.close();
});

function url(path: string): URL {
  return new URL(path, handle.url);
}

describe("streamable HTTP", () => {
  it("GET /mcp is method not allowed", async () => {
    const response = await fetch(url("/mcp"));
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({ error: "Method Not Allowed" });
  });

  it("initialize", async () => {
    const response = await fetch(url("/mcp"), {
      method: "POST",
      headers: STREAMABLE_HEADERS,
      body: JSON.stringify(INITIALIZE_REQUEST),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);

    const body = z
      .object({
        id: z.number(),
        result: z.object({
          protocolVersion: z.string(),
          serverInfo: z.object({ name: z.string() }),
        }),
      })
      .parse(await response.json());
    expect(body.id).toBe(1);
    expect(body.result.serverInfo.name).toBe(SERVER_NAME);
    expect(body.result.protocolVersion).toBe("2025-06-18");
  });

  it("tools/list needs no prior initialize round trip", async () => {
    const response = await fetch(url("/mcp"), {
      method: "POST",
      headers: STREAMABLE_HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      }),
    });
    expect(response.status).toBe(200);

    const body = z
      .object({
        result: z.object({ tools: z.array(z.object({ name: z.string() })) }),
      })
      .parse(await response.json());
    const names = new Set(body.result.tools.map((tool) => tool.name));
    expect(names.has("github_tool")).toBe(true);
    expect(names.has("postgres_tool")).toBe(true);
    expect(names.has("prometheus_tool")).toBe(true);
  });
});
