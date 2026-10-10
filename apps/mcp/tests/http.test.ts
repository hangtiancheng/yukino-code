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

class SseReader {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(body: ReadableStream<Uint8Array> | null) {
    if (body === null) {
      throw new Error("SSE response has no body");
    }
    this.reader = body.getReader();
  }

  async nextEvent(): Promise<Record<string, string>> {
    for (;;) {
      const boundary = this.buffer.indexOf("\n\n");
      if (boundary !== -1) {
        const rawEvent = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 2);
        const event: Record<string, string> = {};
        for (const line of rawEvent.split("\n")) {
          if (line.startsWith(":") || line === "") {
            continue;
          }
          const separator = line.indexOf(":");
          const field = separator === -1 ? line : line.slice(0, separator);
          const value =
            separator === -1 ? "" : line.slice(separator + 1).trim();
          event[field] = value;
        }
        if (Object.keys(event).length > 0) {
          return event;
        }
        continue;
      }
      const chunk = await this.reader.read();
      if (chunk.done) {
        throw new Error("SSE stream ended before a complete event");
      }
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  async cancel(): Promise<void> {
    await this.reader.cancel();
  }
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

describe("legacy SSE", () => {
  it("POST /messages requires a session id", async () => {
    const response = await fetch(url("/messages"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(INITIALIZE_REQUEST),
    });
    expect(response.status).toBe(400);
  });

  it("initialize round trip over the SSE stream", async () => {
    const response = await fetch(url("/sse"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);

    const sse = new SseReader(response.body);
    try {
      const endpointEvent = await sse.nextEvent();
      expect(endpointEvent["event"]).toBe("endpoint");
      const endpoint = endpointEvent["data"] ?? "";
      expect(endpoint.startsWith("/messages?sessionId=")).toBe(true);

      const post = await fetch(url(endpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(INITIALIZE_REQUEST),
      });
      expect(post.status).toBe(202);

      const messageEvent = await sse.nextEvent();
      expect(messageEvent["event"]).toBe("message");
      const message = z
        .object({
          id: z.number(),
          result: z.object({ serverInfo: z.object({ name: z.string() }) }),
        })
        .parse(JSON.parse(messageEvent["data"] ?? ""));
      expect(message.id).toBe(1);
      expect(message.result.serverInfo.name).toBe(SERVER_NAME);
    } finally {
      await sse.cancel();
    }
  }, 30_000);
});
