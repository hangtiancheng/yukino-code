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

// MCP Transport over a WebSocket connection. The MCP SDK ships no WebSocket
// client transport, and the VSCode extension's embedded MCP server only
// speaks ws (subprotocol "mcp"), so we implement the Transport interface here.

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type JSONRPCMessage, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";

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
    const ws = new WebSocket(this.url, ["mcp"], { headers: this.headers });
    this.ws = ws;

    await new Promise<void>((resolvePromise, rejectPromise) => {
      ws.once("open", () => {
        resolvePromise();
      });
      ws.once("error", (err) => {
        rejectPromise(err instanceof Error ? err : new Error(String(err)));
      });
    });

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
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      this.ws.close();
    }
    this.emitClose();
    return Promise.resolve();
  }
}
