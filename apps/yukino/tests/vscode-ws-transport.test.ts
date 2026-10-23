import { once } from "node:events";
import { createServer, type Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WebSocketTransport } from "@yukino.js/vscode/ws-transport.js";

afterEach(() => vi.useRealTimers());

describe("IDE WebSocket startup", () => {
  it("settles a timed-out handshake and handles errors from terminating it", async () => {
    const server = createServer();
    const peers = new Set<Socket>();
    server.on("connection", (socket) => peers.add(socket));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP listener");
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const transport = new WebSocketTransport(
      `ws://127.0.0.1:${String(address.port)}`,
    );
    const onerror = vi.fn();
    const onclose = vi.fn();
    transport.onerror = onerror;
    transport.onclose = onclose;
    const connected = once(server, "connection");
    const start = transport.start().catch((error: unknown) => error);
    try {
      await connected;
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await start).toBeInstanceOf(Error);
      await vi.waitFor(() => {
        expect(onerror).toHaveBeenCalled();
      });
      await transport.close();
      expect(onclose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      await transport.close();
      for (const peer of peers) {
        peer.destroy();
      }
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }
  });
});
