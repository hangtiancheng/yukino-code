// MCP Transport over a WebSocket connection. The MCP SDK's WebSocket client
// transport only accepts a URL and relies on the global WebSocket, so it
// cannot attach the auth header that the VSCode extension's embedded MCP
// server (ws, subprotocol "mcp") may require; hence we implement the
// Transport interface here on top of the `ws` package.

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type JSONRPCMessage,
  JSONRPCMessageSchema,
} from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";

import { START_TIMEOUT_MS } from "@/vscode/constants.js";

export class WebSocketTransport implements Transport {
  private ws: WebSocket | null = null;
  private closeEmitted = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    private url: string,
    private headers: Record<string, string> = {},
  ) {}

  // The SDK's Protocol._onclose tears down state and rejects pending
  // requests; manual close() plus the ws 'close' event must collapse into a
  // single emission.
  private emitClose(): void {
    if (this.closeEmitted) {
      return;
    }
    this.closeEmitted = true;
    this.onclose?.();
  }

  async start(): Promise<void> {
    if (this.ws) {
      throw new Error("Start can only be called once per transport.");
    }
    const ws = new WebSocket(this.url, ["mcp"], {
      headers: this.headers,
      // A server that accepts the TCP connection but never completes the
      // WebSocket handshake would otherwise leave start() pending forever.
      handshakeTimeout: START_TIMEOUT_MS,
    });
    this.ws = ws;

    ws.on("message", (data: WebSocket.RawData) => {
      try {
        const text = Buffer.isBuffer(data)
          ? data.toString("utf-8")
          : Array.isArray(data)
            ? Buffer.concat(data).toString("utf-8")
            : Buffer.from(data).toString("utf-8");
        const raw: unknown = JSON.parse(text);
        this.onmessage?.(JSONRPCMessageSchema.parse(raw));
      } catch (err) {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
      }
    });
    ws.on("error", (err) => {
      this.onerror?.(err instanceof Error ? err : new Error(String(err)));
    });
    ws.on("close", () => {
      this.emitClose();
    });

    await new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      const state: { timer?: NodeJS.Timeout } = {};
      const cleanup = () => {
        if (state.timer) {
          clearTimeout(state.timer);
        }
        ws.off("open", onOpen);
        ws.off("error", onError);
        ws.off("close", onClose);
      };
      const settle = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        fn();
      };
      const onOpen = () => {
        settle(resolvePromise);
      };
      const onError = (err: unknown) => {
        settle(() => {
          rejectPromise(err instanceof Error ? err : new Error(String(err)));
        });
      };
      const onClose = () => {
        settle(() => {
          rejectPromise(
            new Error("WebSocket closed before the handshake completed."),
          );
        });
      };
      ws.on("open", onOpen);
      ws.on("error", onError);
      ws.on("close", onClose);
      // Backstop for the handshake timeout: guarantee start() always settles.
      state.timer = setTimeout(() => {
        settle(() => {
          ws.terminate();
          rejectPromise(
            new Error(
              `WebSocket handshake timed out after ${String(START_TIMEOUT_MS)}ms.`,
            ),
          );
        });
      }, START_TIMEOUT_MS);
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open. Cannot send message.");
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
      ws.send(JSON.stringify(message), (err) => {
        if (err) {
          rejectPromise(err);
        } else {
          resolvePromise();
        }
      });
    });
  }

  close(): Promise<void> {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      this.ws.close();
    }
    this.emitClose();
    return Promise.resolve();
  }
}
