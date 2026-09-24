/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

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
    expect(() => parseAcpWebSocketAddress("0.0.0.0:18889")).toThrow(
      "loopback address",
    );
  });

  it("serves ACP over WebSocket", async () => {
    const port = 20_000 + (process.pid % 20_000);
    const server = await startAcpWebSocketServer(`127.0.0.1:${String(port)}`);
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
});
