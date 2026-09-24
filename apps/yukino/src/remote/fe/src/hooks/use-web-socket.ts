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

import type { ClientMessage, ServerMessage } from "@fe/types";
import { useEffect, useRef } from "react";

interface UseWebSocketOptions {
  onMessage: (message: ServerMessage) => void;
  onOpen: () => void;
  onClose: () => void;
}

interface UseWebSocketResult {
  send: (message: ClientMessage) => void;
}

const PING_INTERVAL_MS = 10_000;
const RECONNECT_DELAY_MS = 3_000;

/**
 * Manage a single WebSocket connection to the remote backend with automatic
 * reconnection and an application-layer ping keepalive.
 *
 * The connection URL is derived from the current location so the same build
 * works in dev (rsbuild proxy) and when served inline by the remote server.
 */
export function useWebSocket(opts: UseWebSocketOptions): UseWebSocketResult {
  const { onMessage, onOpen, onClose } = opts;
  const wsRef = useRef<WebSocket | null>(null);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Latest callbacks kept in refs so the effect can stay stable and avoid
  // tearing down the socket on every render.
  const onMessageRef = useRef(onMessage);
  const onOpenRef = useRef(onOpen);
  const onCloseRef = useRef(onClose);
  onMessageRef.current = onMessage;
  onOpenRef.current = onOpen;
  onCloseRef.current = onClose;

  useEffect(() => {
    let disposed = false;

    const connect = () => {
      if (disposed) {
        return;
      }
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${window.location.host}/ws`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        onOpenRef.current();
        if (pingRef.current) {
          clearInterval(pingRef.current);
        }
        pingRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping", data: {} }));
          }
        }, PING_INTERVAL_MS);
      };

      ws.onclose = () => {
        onCloseRef.current();
        if (pingRef.current) {
          clearInterval(pingRef.current);
          pingRef.current = null;
        }
        if (!disposed) {
          setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };

      ws.onerror = () => {
        // Errors are surfaced via onclose; nothing to do here.
      };

      ws.onmessage = (evt: MessageEvent) => {
        try {
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-unsafe-argument
          const parsed = JSON.parse(evt.data) as ServerMessage;
          onMessageRef.current(parsed);
        } catch (err) {
          console.error("[ws] failed to parse message", err);
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      if (pingRef.current) {
        clearInterval(pingRef.current);
        pingRef.current = null;
      }
      const ws = wsRef.current;
      if (ws) {
        ws.onclose = null;
        try {
          ws.close();
        } catch (err) {
          console.error(err);
          // ignore
        }
        wsRef.current = null;
      }
    };
  }, []);

  const send = (message: ClientMessage): void => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  };

  return { send };
}
