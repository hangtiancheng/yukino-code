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

function rejectedWebSocketStatus(
  url: string,
  headers?: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once("open", () => {
      socket.close();
      reject(new Error("WebSocket unexpectedly opened"));
    });
    socket.once("error", () => undefined);
  });
}

function opensWebSocket(
  url: string,
  headers?: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("open", () => {
      socket.close();
      resolve();
    });
    socket.once("error", reject);
  });
}

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
      expect(server.url).toMatch(
        /^ws:\/\/127\.0\.0\.1:\d+\/acp\?token=[A-Za-z0-9_-]+$/,
      );
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

  it("requires the access token and rejects cross-origin browsers", async () => {
    const server = await startAcpWebSocketServer("0");
    try {
      const authorized = new URL(server.url);
      const withoutToken = new URL(server.url);
      withoutToken.search = "";

      await expect(rejectedWebSocketStatus(withoutToken.href)).resolves.toBe(
        401,
      );
      await expect(
        rejectedWebSocketStatus(authorized.href, {
          Origin: "https://attacker.example",
        }),
      ).resolves.toBe(403);
      await expect(
        opensWebSocket(authorized.href, {
          Origin: `http://${authorized.host}`,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  });
});
