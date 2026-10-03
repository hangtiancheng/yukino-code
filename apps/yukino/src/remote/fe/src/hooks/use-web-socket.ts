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
const ACCESS_TOKEN_KEY = "yukino.remote.accessToken";

function readAccessToken(): string | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const token = params.get("token");
  if (token) {
    window.sessionStorage.setItem(ACCESS_TOKEN_KEY, token);
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    return token;
  }
  return window.sessionStorage.getItem(ACCESS_TOKEN_KEY);
}

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
  const pendingRef = useRef<ClientMessage[]>([]);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const accessTokenRef = useRef<string | null>(null);
  if (accessTokenRef.current === null) {
    accessTokenRef.current = readAccessToken();
  }
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
      const accessToken = accessTokenRef.current;
      if (!accessToken) {
        onCloseRef.current();
        return;
      }
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = new URL(`${proto}//${window.location.host}/ws`);
      url.searchParams.set("token", accessToken);
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        onOpenRef.current();
        for (const message of pendingRef.current.splice(0)) {
          ws.send(JSON.stringify(message));
        }
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
    } else {
      pendingRef.current.push(message);
    }
  }, []);

  return { send };
}
