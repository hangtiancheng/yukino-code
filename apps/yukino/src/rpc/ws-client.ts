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

// WebSocket client for the Yukino agent bridge's standalone websocket server
// (yukino/ws, served by cmd/yukino-code-ws). It speaks the bridge's native
// JSON-RPC 2.0 — one text frame per message — and implements the same AgentRpc
// surface as the Connect client, so a RemoteAgent drives it unchanged.
//
// The connection is established lazily on first use (watch or a request), and
// both paths await the same handshake. Because the server attaches the
// connection before it reads any request, awaiting the handshake before sending
// a prompt guarantees the prompt is processed with this client already
// attached, so no early event is lost.

import WebSocket from "ws";

import type {
  AgentRpc,
  PermissionAnswer,
  RemoteEvent,
  RpcContentBlock,
} from "./client.js";
import {
  EventQueue,
  JsonRpcPeer,
  mapJsonRpcEvent,
  promptPayload,
  readBoolFlag,
  readProviderResult,
} from "./jsonrpc.js";

/** Options for createWsAgentRpc. */
export interface WsAgentRpcOptions {
  /** WebSocket URL of the yukino-code-ws server, e.g. ws://127.0.0.1:7861/ws. */
  url: string;
}

// rawDataToString decodes one websocket payload to text. The bridge always
// sends UTF-8 JSON text frames, but ws types the payload as
// Buffer | ArrayBuffer | Buffer[], and ArrayBuffer.toString() would yield
// "[object ArrayBuffer]" — so each case is decoded explicitly.
function rawDataToString(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return Buffer.concat(data).toString("utf8");
}

/** createWsAgentRpc builds a Node/Ink client for the bridge's websocket transport. */
export function createWsAgentRpc(opts: WsAgentRpcOptions): AgentRpc {
  const queue = new EventQueue();

  let socket: WebSocket | null = null;
  let peer: JsonRpcPeer | null = null;
  let connecting: Promise<WebSocket> | null = null;
  let disposed = false;

  // connect returns the open socket, establishing the connection at most once.
  // Both watch() and every request await it, so the server has attached this
  // connection before any prompt it is then sent.
  function connect(): Promise<WebSocket> {
    if (socket?.readyState === WebSocket.OPEN) {
      return Promise.resolve(socket);
    }
    if (connecting) {
      return connecting;
    }
    connecting = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(opts.url);
      const p = new JsonRpcPeer((encoded) => {
        ws.send(encoded);
      });
      p.onNotification((method, params) => {
        const ev = mapJsonRpcEvent(method, params);
        if (ev) {
          queue.push(ev);
        }
      });
      ws.on("open", () => {
        socket = ws;
        peer = p;
        connecting = null;
        resolve(ws);
      });
      ws.on("message", (data) => {
        p.feed(rawDataToString(data));
      });
      ws.on("error", (err) => {
        // A pre-open error rejects the pending handshake; a post-open error is
        // always followed by "close", which settles everything.
        if (connecting) {
          connecting = null;
          reject(err);
        }
      });
      ws.on("close", () => {
        p.failAll(new Error("websocket closed"));
        if (socket === ws) {
          socket = null;
          peer = null;
        }
        if (!disposed) {
          queue.push({
            type: "error",
            error: new Error("connection to the agent bridge closed"),
          });
        }
        queue.close();
      });
    });
    return connecting;
  }

  async function request(method: string, params?: unknown): Promise<unknown> {
    await connect();
    if (!peer) {
      throw new Error("websocket is not connected");
    }
    return peer.request(method, params);
  }

  function teardown(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    const ws = socket;
    socket = null;
    peer = null;
    queue.close();
    if (ws) {
      try {
        ws.close();
      } catch {
        /** noop */
      }
    }
  }

  return {
    async *watch(signal?: AbortSignal): AsyncIterable<RemoteEvent> {
      // Establish the socket (and therefore the server-side attachment) before
      // streaming; a failure surfaces as an error event and ends the stream.
      try {
        await connect();
      } catch (err) {
        queue.push({
          type: "error",
          error: err instanceof Error ? err : new Error(String(err)),
        });
        queue.close();
      }
      if (signal) {
        if (signal.aborted) {
          teardown();
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            teardown();
          },
          { once: true },
        );
      }
      yield* queue.iterate();
    },
    async sendPrompt(content: string): Promise<boolean> {
      const res = await request("session/prompt", { content });
      return readBoolFlag(res, "queued");
    },
    async sendPromptBlocks(blocks: RpcContentBlock[]): Promise<boolean> {
      const res = await request("session/prompt", promptPayload(blocks));
      return readBoolFlag(res, "queued");
    },
    async respondPermission(
      id: string,
      answer: PermissionAnswer,
    ): Promise<boolean> {
      const res = await request("permission/respond", {
        id,
        response: answer,
      });
      return readBoolFlag(res, "applied");
    },
    async respondQuestions(
      id: string,
      answers: Record<string, string>,
    ): Promise<boolean> {
      const res = await request("question/respond", { id, answers });
      return readBoolFlag(res, "applied");
    },
    async cancel(): Promise<void> {
      await request("session/cancel");
    },
    async ping(): Promise<void> {
      await request("ping");
    },
    async selectProvider(name: string) {
      const res = await request("session/select_provider", { name });
      return readProviderResult(res);
    },
    dispose(): void {
      teardown();
    },
  };
}
