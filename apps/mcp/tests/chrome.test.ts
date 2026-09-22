import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createServer } from "@/server.js";
import { BROWSER_TOOLS } from "@/tools/chrome/browser-tools.js";
import { createChromeToolModule } from "@/tools/chrome/tool.js";
import type {
  YukinoForChromeContext,
  Logger,
  SocketClient,
} from "@/tools/chrome/types.js";

const CallToolResultSchema = z.looseObject({
  isError: z.boolean().optional(),
  content: z.array(
    z.looseObject({ type: z.string(), text: z.string().optional() }),
  ),
});

const noopLogger: Logger = {
  info: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  silly: () => undefined,
};

class FakeSocketClient implements SocketClient {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  disconnected = false;

  ensureConnected(): Promise<boolean> {
    return Promise.resolve(true);
  }

  callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, args });
    return Promise.resolve({
      result: { content: [{ type: "text", text: `${name} completed` }] },
    });
  }

  isConnected(): boolean {
    return true;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  setNotificationHandler(): void {}
}

function createContext(isDisabled = false): YukinoForChromeContext {
  return {
    serverName: "test-chrome",
    logger: noopLogger,
    socketPath: "/tmp/test-chrome.sock",
    clientTypeId: "claude-code",
    onToolCallDisconnected: () => "not connected",
    isDisabled: () => isDisabled,
  };
}

async function connect(server: McpServer): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(clientTransport);
  await client.connect(serverTransport);
  return client;
}

describe("Chrome tools", () => {
  it("registers every browser tool on the main server", async () => {
    const client = await connect(createServer());
    const { tools } = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));

    for (const tool of BROWSER_TOOLS) {
      expect(names.has(tool.name)).toBe(true);
    }
  });

  it("forwards validated calls to the shared socket client", async () => {
    const socketClient = new FakeSocketClient();
    const module = createChromeToolModule(createContext(), socketClient);
    const server = new McpServer({ name: "test-server", version: "0.0.0" });
    module.register(server);
    const client = await connect(server);

    const result = CallToolResultSchema.parse(
      await client.callTool({
        name: "navigate",
        arguments: { url: "https://example.com", tabId: 42 },
      }),
    );

    expect(socketClient.calls).toEqual([
      { name: "navigate", args: { url: "https://example.com", tabId: 42 } },
    ]);
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe("navigate completed");
  });

  it("rejects invalid arguments before calling the socket", async () => {
    const socketClient = new FakeSocketClient();
    const module = createChromeToolModule(createContext(), socketClient);
    const server = new McpServer({ name: "test-server", version: "0.0.0" });
    module.register(server);
    const client = await connect(server);

    const result = CallToolResultSchema.parse(
      await client.callTool({
        name: "navigate",
        arguments: { url: "https://example.com" },
      }),
    );

    expect(result.isError).toBe(true);
    expect(socketClient.calls).toEqual([]);
  });

  it("does not register tools when disabled", async () => {
    const socketClient = new FakeSocketClient();
    const module = createChromeToolModule(createContext(true), socketClient);
    const server = new McpServer({ name: "test-server", version: "0.0.0" });
    server.registerTool(
      "sentinel",
      { inputSchema: z.looseObject({}) },
      async () => ({
        content: [{ type: "text", text: "ok" }],
      }),
    );
    module.register(server);
    const client = await connect(server);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["sentinel"]);
  });

  it("disconnects the shared socket client during shutdown", async () => {
    const socketClient = new FakeSocketClient();
    const module = createChromeToolModule(createContext(), socketClient);

    await module.shutdown?.();

    expect(socketClient.disconnected).toBe(true);
  });
});
