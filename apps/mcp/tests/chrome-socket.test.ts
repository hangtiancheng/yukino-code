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

import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import type { Server as NetServer, Socket } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createMcpSocketClient } from "@/tools/chrome/mcp-socket-client.js";
import type { McpSocketClient } from "@/tools/chrome/mcp-socket-client.js";
import type { Logger, YukinoForChromeContext } from "@/tools/chrome/types.js";

const noopLogger: Logger = {
  info: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  silly: () => undefined,
};

function createContext(socketPath: string): YukinoForChromeContext {
  return {
    serverName: "test-socket",
    logger: noopLogger,
    socketPath,
    clientTypeId: "claude-code",
    onToolCallDisconnected: () => "not connected",
  };
}

interface FakeNativeHost {
  /** Destroy every live connection so the client observes a remote close. */
  dropConnections(): void;
  close(): Promise<void>;
}

/** Listen on a unix socket with the 0600 mode validateSocketSecurity requires. */
function listenUnixSocket(socketPath: string): Promise<FakeNativeHost> {
  return new Promise((resolve, reject) => {
    const connections = new Set<Socket>();
    const server: NetServer = createServer((socket) => {
      connections.add(socket);
      socket.on("close", () => connections.delete(socket));
      socket.on("error", () => undefined);
    });
    server.once("error", reject);
    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o600);
      resolve({
        dropConnections() {
          for (const socket of connections) {
            socket.destroy();
          }
          connections.clear();
        },
        close: () =>
          new Promise<void>((done) => {
            for (const socket of connections) {
              socket.destroy();
            }
            connections.clear();
            server.close(() => done());
          }),
      });
    });
  });
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("McpSocketClient reconnection", () => {
  let dir: string;
  let socketPath: string;
  let host: FakeNativeHost | undefined;
  let client: McpSocketClient | undefined;

  afterEach(async () => {
    client?.disconnect();
    client = undefined;
    await host?.close();
    host = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  // Regression test: a remote close used to leave a dead (non-null) socket in
  // the client, so ensureConnected() skipped connect() and polled a connection
  // that could never succeed. Pool clients run with auto-reconnect disabled,
  // which is exactly this path — reconnection must happen via ensureConnected.
  it("reconnects the same client after the native host restarts", async () => {
    dir = mkdtempSync(join(tmpdir(), "yukino-mcp-socket-test-"));
    socketPath = join(dir, "bridge.sock");

    host = await listenUnixSocket(socketPath);
    client = createMcpSocketClient(createContext(socketPath));
    client.disableAutoReconnect = true;
    expect(await client.ensureConnected()).toBe(true);

    // Native host dies: the client observes a remote close, not a local
    // disconnect() (which would legitimately tear the client down).
    host.dropConnections();
    await waitFor(() => !client!.isConnected());
    await host.close();
    host = undefined;

    // Host restarts on the same socket path (stale file must go first).
    rmSync(socketPath, { force: true });
    host = await listenUnixSocket(socketPath);

    // The same client instance must recover. Before the fix this rejected
    // with SocketConnectionError after the 5s poll timeout.
    expect(await client.ensureConnected()).toBe(true);
  }, 15_000);
});
