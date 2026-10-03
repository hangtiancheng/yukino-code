import * as acp from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { createYukinoAcpApp } from "@/acp/agent.js";
import { parseAcpMode } from "@/acp/index.js";
import {
  parseAcpWebSocketAddress,
  startAcpWebSocketServer,
} from "@/acp/websocket.js";

describe("ACP transports", () => {
  it("advertises only implemented capabilities", async () => {
    const implementation = createYukinoAcpApp();
    const client = acp.client({ name: "test-client" });

    await client.connectWith(implementation.app, async (context) => {
      const response = await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      expect(response.agentInfo?.name).toBe("yukino");
      expect(response.agentCapabilities).toEqual({
        loadSession: true,
        promptCapabilities: { embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      });
    });
  });

  it("parses ACP CLI modes and restricts WebSocket to loopback", () => {
    expect(parseAcpMode(["--acp"])).toEqual({ transport: "stdio" });
    expect(parseAcpMode(["--acp-ws"])).toEqual({ transport: "websocket" });
    expect(parseAcpMode(["--acp-ws", "127.0.0.1:9000"])).toEqual({
      transport: "websocket",
      address: "127.0.0.1:9000",
    });
    expect(() => parseAcpMode(["--acp", "--remote"])).toThrow();
    expect(parseAcpWebSocketAddress()).toEqual({
      host: "127.0.0.1",
      port: 18889,
    });
    // A bare host keeps the ACP WebSocket default port, not remote's 18888.
    expect(parseAcpWebSocketAddress("localhost")).toEqual({
      host: "localhost",
      port: 18889,
    });
    // Port 0 binds an ephemeral port; the server advertises the bound URL.
    expect(parseAcpWebSocketAddress("0")).toEqual({
      host: "127.0.0.1",
      port: 0,
    });
    expect(() => parseAcpWebSocketAddress("0.0.0.0:18889")).toThrow(
      "loopback address",
    );
  });

  it("serves ACP over WebSocket", async () => {
    const server = await startAcpWebSocketServer("0");
    try {
      const stream = createWebSocketStream(server.url, { WebSocket });
      const client = acp.client({ name: "websocket-test-client" });
      await client.connectWith(stream, async (context) => {
        const response = await context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        expect(response.protocolVersion).toBe(acp.PROTOCOL_VERSION);
        expect(response.agentInfo?.name).toBe("yukino");
      });
    } finally {
      await server.close();
    }
  });

  it("binds an ephemeral port and advertises the reachable URL", async () => {
    const server = await startAcpWebSocketServer("0");
    try {
      expect(server.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/acp$/);
      expect(server.url).not.toContain(":0/");
      const stream = createWebSocketStream(server.url, { WebSocket });
      const client = acp.client({ name: "websocket-ephemeral-client" });
      await client.connectWith(stream, async (context) => {
        const response = await context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        expect(response.agentInfo?.name).toBe("yukino");
      });
    } finally {
      await server.close();
    }
  });
});
