import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { A2aRuntime, A2aRuntimeFactory } from "@/a2a/executor.js";
import { parseA2aMode } from "@/a2a/index.js";
import { parseA2aAddress, startA2aServer } from "@/a2a/server.js";
import type { AgentEvent } from "@/agent/events.js";

const CardSchema = z.object({
  name: z.string(),
  url: z.string().optional(),
  protocolVersion: z.string().optional(),
  supportedInterfaces: z
    .array(
      z.object({
        protocolBinding: z.string(),
        protocolVersion: z.string(),
        url: z.string(),
      }),
    )
    .optional(),
});

const TaskResultSchema = z.object({
  id: z.string(),
  contextId: z.string(),
  status: z.object({
    state: z.string(),
    message: z
      .object({
        parts: z.array(
          z.object({
            text: z.string().optional(),
            data: z.unknown().optional(),
          }),
        ),
      })
      .optional(),
  }),
});

const JsonRpcTaskSchema = z.object({
  result: z.object({ task: TaskResultSchema }),
});

const JsonRpcMessageSchema = z.object({
  result: z.object({ message: z.object({ parts: z.array(z.unknown()) }) }),
});

const RestTaskSchema = z.object({ task: TaskResultSchema });

function fakeRuntimeFactory(
  events: AgentEvent[] = [{ type: "loop_complete", stopReason: "end_turn" }],
): A2aRuntimeFactory {
  return (cwd) => {
    const runtime: A2aRuntime = {
      sessionId: "session-12345678",
      cwd,
      async *run() {
        await Promise.resolve();
        for (const event of events) {
          yield event;
        }
      },
      abort: () => undefined,
      dispose: () => Promise.resolve(),
    };
    return Promise.resolve(runtime);
  };
}

function testPort(offset: number): string {
  return `127.0.0.1:${String(20_000 + ((process.pid + offset) % 20_000))}`;
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return response.json();
}

const V1 = { "a2a-version": "1.0" };

function sendParams(messageId: string, text: string, contextId?: string) {
  return {
    jsonrpc: "2.0",
    id: messageId,
    method: "SendMessage",
    params: {
      message: {
        messageId,
        role: "user",
        parts: [{ text }],
        ...(contextId ? { contextId } : {}),
      },
    },
  };
}

describe("A2A server", () => {
  const servers: Awaited<ReturnType<typeof startA2aServer>>[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (server) {
        await server.close();
      }
    }
  });

  it("parses the CLI mode and restricts the address to loopback", () => {
    expect(parseA2aMode(["--a2a"])).toEqual({});
    expect(parseA2aMode(["--a2a", "127.0.0.1:9000"])).toEqual({
      address: "127.0.0.1:9000",
    });
    expect(parseA2aMode(["--remote"])).toBeNull();
    expect(() => parseA2aMode(["--a2a", "--remote"])).toThrow();
    expect(parseA2aAddress()).toEqual({ host: "127.0.0.1", port: 18890 });
    // A bare host keeps the A2A default port, not the remote-mode 18888.
    expect(parseA2aAddress("localhost")).toEqual({
      host: "localhost",
      port: 18890,
    });
    // Port 0 binds an ephemeral port; the server advertises the bound address.
    expect(parseA2aAddress("0")).toEqual({ host: "127.0.0.1", port: 0 });
    expect(parseA2aAddress("127.0.0.1:0")).toEqual({
      host: "127.0.0.1",
      port: 0,
    });
    expect(() => parseA2aAddress("0.0.0.0:18890")).toThrow("loopback");
  });

  it("binds an ephemeral port and advertises the reachable address", async () => {
    const server = await startA2aServer({
      address: "0",
      runtimeFactory: fakeRuntimeFactory(),
    });
    servers.push(server);
    // Port 0 must resolve to a real, reachable port in the advertised URLs.
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(server.url).not.toContain(":0/");
    const card = CardSchema.parse(await (await fetch(server.cardUrl)).json());
    for (const iface of card.supportedInterfaces ?? []) {
      expect(iface.url).toBe(server.url);
    }
  });

  it("advertises only v1.0 JSON-RPC and REST interfaces", async () => {
    const server = await startA2aServer({
      address: testPort(1),
      runtimeFactory: fakeRuntimeFactory(),
    });
    servers.push(server);

    const card = CardSchema.parse(await (await fetch(server.cardUrl)).json());
    expect(card.name).toBe("yukino");
    expect(card.supportedInterfaces).toHaveLength(2);
    expect(
      card.supportedInterfaces?.map((iface) => iface.protocolBinding),
    ).toEqual(["JSONRPC", "HTTP+JSON"]);
    for (const iface of card.supportedInterfaces ?? []) {
      expect(iface.url).toBe(server.url);
    }

    expect(
      card.supportedInterfaces?.every(
        (iface) => iface.protocolVersion === "1.0",
      ),
    ).toBe(true);
  });

  it("rejects removed JSON-RPC methods without running the agent", async () => {
    let runs = 0;
    const factory = fakeRuntimeFactory();
    const server = await startA2aServer({
      address: "0",
      runtimeFactory: (cwd) => {
        runs++;
        return factory(cwd);
      },
    });
    servers.push(server);
    const response = z.object({ error: z.object({ code: z.number() }) }).parse(
      await postJson(
        server.url,
        {
          jsonrpc: "2.0",
          id: "removed-method",
          method: "message/send",
          params: {},
        },
        V1,
      ),
    );
    expect(response.error.code).toBe(-32601);
    expect(runs).toBe(0);
  });

  it("completes a task over v1.0 JSON-RPC and REST", async () => {
    const server = await startA2aServer({
      address: testPort(3),
      runtimeFactory: fakeRuntimeFactory([
        { type: "stream_text", text: "done" },
        { type: "loop_complete", stopReason: "end_turn" },
      ]),
    });
    servers.push(server);

    const rpc = JsonRpcTaskSchema.parse(
      await postJson(server.url, sendParams("m1", "hello"), V1),
    );
    expect(rpc.result.task.status.state).toBe("TASK_STATE_COMPLETED");

    const restResponse = await fetch(`${server.url}v1/message:send`, {
      method: "POST",
      headers: { "content-type": "application/json", ...V1 },
      body: JSON.stringify({
        message: {
          messageId: "m2",
          role: "user",
          parts: [{ text: "hello again" }],
        },
      }),
    });
    expect(restResponse.status).toBe(200);
    const rest = RestTaskSchema.parse(await restResponse.json());
    expect(rest.task.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("streams status updates over SSE", async () => {
    const server = await startA2aServer({
      address: testPort(4),
      runtimeFactory: fakeRuntimeFactory([
        { type: "stream_text", text: "chunk" },
        { type: "loop_complete", stopReason: "end_turn" },
      ]),
    });
    servers.push(server);

    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...V1,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "s1",
        method: "SendStreamingMessage",
        params: {
          message: {
            messageId: "s1",
            role: "user",
            parts: [{ text: "stream me" }],
          },
        },
      }),
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const sse = await response.text();
    const states = [...sse.matchAll(/"state":"(TASK_STATE_\w+)"/g)].map(
      (match) => match[1],
    );
    expect(states).toEqual([
      "TASK_STATE_SUBMITTED",
      "TASK_STATE_WORKING",
      "TASK_STATE_COMPLETED",
    ]);
  });

  it("rejects a new message while the context is busy", async () => {
    let permit: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      permit = resolve;
    });
    const factory: A2aRuntimeFactory = (cwd) =>
      Promise.resolve<A2aRuntime>({
        sessionId: "session-12345678",
        cwd,
        async *run() {
          yield { type: "stream_text", text: "busy" };
          await gate;
          yield { type: "loop_complete", stopReason: "end_turn" };
        },
        abort: () => undefined,
        dispose: () => Promise.resolve(),
      });
    const server = await startA2aServer({
      address: testPort(5),
      runtimeFactory: factory,
    });
    servers.push(server);

    const immediate = {
      ...V1,
    };
    const sendNow = (messageId: string, text: string, contextId?: string) =>
      postJson(
        server.url,
        {
          jsonrpc: "2.0",
          id: messageId,
          method: "SendMessage",
          params: {
            configuration: { returnImmediately: true },
            message: {
              messageId,
              role: "user",
              parts: [{ text }],
              ...(contextId ? { contextId } : {}),
            },
          },
        },
        immediate,
      );

    try {
      const first = JsonRpcTaskSchema.parse(await sendNow("m1", "start"));
      const contextId = first.result.task.contextId;
      expect(contextId).toBeTruthy();

      const second = JsonRpcMessageSchema.parse(
        await sendNow("m2", "interrupt", contextId),
      );
      const parts = second.result.message.parts;
      expect(JSON.stringify(parts)).toContain("busy");
    } finally {
      permit();
    }
  });
});
