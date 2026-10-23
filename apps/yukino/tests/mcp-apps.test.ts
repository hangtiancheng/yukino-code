import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpAppToolResult } from "@yukino.js/model-context-protocol/apps.js";
import { MCPClient } from "@yukino.js/model-context-protocol/client.js";
import { MCPManager } from "@yukino.js/model-context-protocol/manager.js";
import { PermissionChecker } from "@yukino.js/permissions";
import {
  RemoteMcpApps,
  type McpAppHandle,
} from "@yukino.js/remote/mcp-apps.js";
import {
  chatReducer,
  initialState,
} from "@yukino.js/remote-browser/hooks/use-chat.js";
import { McpAppRequests } from "@yukino.js/remote-browser/lib/mcp-app-requests.js";
import { buildAppCsp } from "@yukino.js/remote-browser/lib/mcp-app-sandbox.js";
import type { ClientMessage } from "@yukino.js/remote-browser/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.restoreAllMocks());

const app: McpAppToolResult = {
  toolId: "app-1",
  toolName: "McpCall",
  output: "Rendered app",
  isError: false,
  elapsed: 1,
  mcpApp: {
    serverName: "server",
    toolName: "create_app",
    resourceUri: "ui://test/app.html",
    arguments: { html: "<h1>Hello</h1>" },
    result: {
      content: [{ type: "text", text: "Rendered app" }],
      structuredContent: { title: "App" },
      _meta: { html: "<h1>Hello</h1>" },
    },
  },
};

function connected() {
  const sdk = new Client({ name: "test", version: "1" });
  const client = new MCPClient({ name: "server" }, true);
  Reflect.set(client, "client", sdk);
  return { client, sdk };
}

async function broker() {
  const { client, sdk } = connected();
  vi.spyOn(sdk, "listTools").mockResolvedValue({
    tools: [
      {
        name: "refresh",
        inputSchema: { type: "object" },
        _meta: { ui: { visibility: ["app"] } },
      },
      {
        name: "model_only",
        inputSchema: { type: "object" },
        _meta: { ui: { visibility: ["model"] } },
      },
    ],
  });
  await client.listTools();
  const manager = new MCPManager(true);
  vi.spyOn(manager, "getClient").mockReturnValue(client);
  const handle: McpAppHandle = {
    sessionId: "session-1",
    cwd: process.cwd(),
    mcpManager: manager,
    checker: new PermissionChecker(process.cwd(), "bypassPermissions"),
    toolFilter: null,
    hookEngine: null,
  };
  const host = new RemoteMcpApps();
  host.register(app, handle);
  return { host, client, sdk, manager, handle };
}

describe("MCP Apps metadata", () => {
  it("preserves raw results for views and keeps app-only tools out of model discovery", async () => {
    const { client, sdk } = connected();
    vi.spyOn(sdk, "listTools").mockResolvedValue({
      tools: [
        {
          name: "create_app",
          inputSchema: { type: "object" },
          _meta: { ui: { resourceUri: app.mcpApp.resourceUri } },
        },
        {
          name: "refresh",
          inputSchema: { type: "object" },
          _meta: { ui: { visibility: ["app"] } },
        },
      ],
    });
    expect((await client.listTools()).map((tool) => tool.name)).toEqual([
      "create_app",
    ]);
    expect(client.getTool("refresh")).toBeDefined();
    vi.spyOn(sdk, "callTool").mockResolvedValue(app.mcpApp.result);
    const result = await client.callTool("create_app", app.mcpApp.arguments);
    expect(result.mcpApp).toEqual(app.mcpApp);
    expect(result.output).toBe("Rendered app");
    expect(result.output).not.toContain("<h1>");
  });

  it("keeps the App attached to its tool row when reconnect results are replayed", () => {
    const frame = {
      kind: "message",
      message: { type: "tool_result", data: app },
    } as const;
    const first = chatReducer(initialState, frame);
    const replay = chatReducer(first, frame);
    expect(replay.items).toHaveLength(1);
    expect(replay.items[0]).toMatchObject({
      toolName: "McpCall",
      mcpApp: app.mcpApp,
    });
  });
});

describe("remote App server access", () => {
  it("reads resources only through the server that created the App", async () => {
    const { host, client, handle } = await broker();
    const read = vi
      .spyOn(client, "readResource")
      .mockResolvedValue({ contents: [] });
    await host.request(
      {
        requestId: "r1",
        appId: app.toolId,
        method: "read_resource",
        params: { uri: app.mcpApp.resourceUri },
      },
      handle,
      vi.fn(),
      new AbortController().signal,
    );
    expect(read).toHaveBeenCalledWith(
      app.mcpApp.resourceUri,
      expect.any(AbortSignal),
    );
    handle.sessionId = "other-session";
    await expect(
      host.request(
        {
          requestId: "r2",
          appId: app.toolId,
          method: "read_resource",
          params: { uri: app.mcpApp.resourceUri },
        },
        handle,
        vi.fn(),
        new AbortController().signal,
      ),
    ).rejects.toThrow("no longer connected");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("enforces visibility and permissions on UI tool calls", async () => {
    const { host, client, handle } = await broker();
    const call = vi
      .spyOn(client, "callToolResult")
      .mockResolvedValue({ content: [] });
    const permission = vi.fn().mockResolvedValue("deny");
    const request = {
      requestId: "r1",
      appId: app.toolId,
      method: "call_tool",
      params: { name: "refresh", arguments: {} },
    } as const;
    handle.checker.mode = "default";
    await expect(
      host.request(request, handle, permission, new AbortController().signal),
    ).rejects.toThrow("Permission denied");
    expect(permission).toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    handle.checker.mode = "bypassPermissions";
    await host.request(
      request,
      handle,
      permission,
      new AbortController().signal,
    );
    expect(call).toHaveBeenCalledTimes(1);
    await expect(
      host.request(
        { ...request, params: { name: "model_only" } },
        handle,
        permission,
        new AbortController().signal,
      ),
    ).rejects.toThrow("not available");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("revokes apps when their server connection is replaced or their transcript is cleared", async () => {
    const { host, manager, handle } = await broker();
    const request = {
      requestId: "r1",
      appId: app.toolId,
      method: "read_resource",
      params: { uri: app.mcpApp.resourceUri },
    } as const;
    vi.spyOn(manager, "getClient").mockReturnValue(
      new MCPClient({ name: "server" }, true),
    );
    await expect(
      host.request(request, handle, vi.fn(), new AbortController().signal),
    ).rejects.toThrow("no longer connected");
    host.clear();
    expect(host.entries()).toEqual([]);
    await expect(
      host.request(request, handle, vi.fn(), new AbortController().signal),
    ).rejects.toThrow("no longer connected");
  });
});

describe("App browser transport and sandbox", () => {
  it("correlates concurrent results and rejects in-flight requests on disconnect", async () => {
    const requests = new McpAppRequests();
    const messages: ClientMessage[] = [];
    const send = (message: ClientMessage) => {
      messages.push(message);
      return "sent";
    };
    const operation = {
      method: "read_resource",
      params: { uri: app.mcpApp.resourceUri },
    } as const;
    const first = requests.request(app.toolId, operation, send);
    const second = requests.request(app.toolId, operation, send);
    const frame = messages[1];
    if (frame.type !== "mcp_app_request") {
      throw new Error("Missing request");
    }
    requests.receive({
      type: "mcp_app_response",
      data: { requestId: frame.data.requestId, result: "second" },
    });
    await expect(second).resolves.toBe("second");
    requests.close();
    await expect(first).rejects.toThrow("disconnected");
    await expect(
      requests.request(app.toolId, operation, () => "dropped"),
    ).rejects.toThrow("disconnected");
  });

  it("restricts resources to declared domains and rejects CSP directive injection", () => {
    const csp = buildAppCsp({
      resourceDomains: [
        "https://cdn.example.com",
        "https://evil.test; connect-src *",
        "'self'",
      ],
      connectDomains: ["https://api.example.com"],
      frameDomains: [],
    });
    expect(csp).toContain("script-src 'unsafe-inline' https://cdn.example.com");
    expect(csp).toContain("connect-src https://api.example.com");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("evil");
    expect(csp).not.toContain("'self'");
    expect(buildAppCsp()).toContain("connect-src 'none'");
  });
});
