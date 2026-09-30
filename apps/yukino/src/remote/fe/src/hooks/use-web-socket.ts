import type { ClientMessage, ServerMessage } from "@fe/types";
import { isServerMessage } from "@fe/types";
import { useCallback, useEffect, useRef } from "react";

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
 * works from any host that serves it; it always dials the same origin at a
 * fixed /ws path.
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
        const raw: unknown = evt.data;
        if (typeof raw !== "string") {
          console.warn("[ws] dropping non-text frame");
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          console.error("[ws] failed to parse message", err);
          return;
        }
        if (!isServerMessage(parsed)) {
          console.warn("[ws] dropping malformed server message", parsed);
          return;
        }
        onMessageRef.current(parsed);
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
        }
        wsRef.current = null;
      }
    };
  }, []);

  // Stable identity: app.tsx memoizes its callbacks on [send], so a fresh
  // function per render would defeat every one of them.
  const send = useCallback((message: ClientMessage): void => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }, []);

  return { send };
}
