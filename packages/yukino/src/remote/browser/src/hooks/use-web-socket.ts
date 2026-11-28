import { WebSocket as ReconnectingWebSocket } from "partysocket";
import { useCallback, useEffect, useRef } from "react";

import {
  ACCESS_TOKEN_KEY,
  PING_INTERVAL_MS,
  QUEUEABLE_OFFLINE,
  RECONNECT_DELAY_MS,
} from "#/constants.js";
import { OfflineMessageQueue } from "#/hooks/offline-queue.js";
import { McpAppRequests, type RequestApp } from "#/lib/mcp-app-requests.js";
import type { ClientMessage, ServerMessage } from "#/types.js";
import { isServerMessage } from "#/types.js";

interface UseWebSocketOptions {
  onMessage: (message: ServerMessage) => void;
  onOpen: () => void;
  onClose: () => void;
  onAuthRequired: () => void;
}

/** Whether an offline send was delivered, held for replay, or dropped. */
export type SendStatus = "sent" | "queued" | "dropped";

interface UseWebSocketResult {
  send: (message: ClientMessage) => SendStatus;
  requestApp: RequestApp;
}

function readInviteToken(): string | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const token = params.get("token");
  if (token) {
    window.sessionStorage.setItem(ACCESS_TOKEN_KEY, token);
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  }
  return token || null;
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
  const wsRef = useRef<ReconnectingWebSocket | null>(null);
  const appRequests = useRef(new McpAppRequests());
  const pendingRef = useRef(new OfflineMessageQueue());
  // Latest callbacks kept in refs so the effect can stay stable and avoid
  // tearing down the socket on every render.
  const onMessageRef = useRef(onMessage);
  const onOpenRef = useRef(onOpen);
  const onCloseRef = useRef(onClose);
  const onAuthRequiredRef = useRef(opts.onAuthRequired);
  onAuthRequiredRef.current = opts.onAuthRequired;
  onMessageRef.current = onMessage;
  onOpenRef.current = onOpen;
  onCloseRef.current = onClose;

  useEffect(() => {
    const requests = appRequests.current;
    const pending = pendingRef.current;
    let accessToken =
      readInviteToken() ?? window.sessionStorage.getItem(ACCESS_TOKEN_KEY);
    let ping: ReturnType<typeof setInterval> | undefined;
    let authProbe: AbortController | undefined;
    const incoming: ServerMessage[] = [];
    let incomingFrame: number | undefined;
    const flushIncoming = () => {
      if (incomingFrame !== undefined) {
        cancelAnimationFrame(incomingFrame);
        incomingFrame = undefined;
      }
      for (const message of incoming.splice(0)) {
        onMessageRef.current(message);
      }
    };
    const receive = (message: ServerMessage) => {
      if (requests.receive(message)) {
        return;
      }
      if (
        message.type !== "stream_text" &&
        message.type !== "thinking_text" &&
        message.type !== "tool_output"
      ) {
        flushIncoming();
        onMessageRef.current(message);
        return;
      }
      const last = incoming.at(-1);
      if (
        (message.type === "stream_text" && last?.type === "stream_text") ||
        (message.type === "thinking_text" && last?.type === "thinking_text")
      ) {
        last.data.text += message.data.text;
      } else if (
        message.type === "tool_output" &&
        last?.type === "tool_output" &&
        last.data.toolId === message.data.toolId
      ) {
        last.data.output = message.data.output;
      } else {
        incoming.push(message);
      }
      incomingFrame ??= requestAnimationFrame(flushIncoming);
    };

    const stopPing = () => {
      clearInterval(ping);
      ping = undefined;
    };
    const disconnect = () => {
      authProbe?.abort();
      authProbe = undefined;
      stopPing();
      requests.close();
      pending.drain();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onopen = null;
        ws.onclose = null;
        ws.onmessage = null;
        ws.close();
      }
    };

    const connect = (token: string | null) => {
      if (!token) {
        onAuthRequiredRef.current();
        return;
      }
      const url = new URL("/ws", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("token", token);
      const ws = new ReconnectingWebSocket(url.href, [], {
        minReconnectionDelay: RECONNECT_DELAY_MS,
        maxReconnectionDelay: 30_000,
        reconnectionDelayGrowFactor: 1.5,
        connectionTimeout: 10_000,
        maxEnqueuedMessages: 0,
      });

      wsRef.current = ws;

      ws.onopen = () => {
        authProbe?.abort();
        authProbe = undefined;
        onOpenRef.current();
        for (const json of pending.drain()) {
          ws.send(json);
        }
        stopPing();
        ping = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping", data: {} }));
          }
        }, PING_INTERVAL_MS);
      };

      ws.onclose = () => {
        stopPing();
        requests.close();
        flushIncoming();
        onCloseRef.current();
        authProbe?.abort();
        const probe = new AbortController();
        authProbe = probe;
        const authUrl = new URL("/auth", window.location.href);
        authUrl.searchParams.set("token", token);
        void fetch(authUrl, { cache: "no-store", signal: probe.signal })
          .then((response) => {
            if (response.status === 401 && !probe.signal.aborted) {
              disconnect();
              onAuthRequiredRef.current();
            }
          })
          .catch(() => {});
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
        receive(parsed);
      };
    };

    const onHashChange = () => {
      const token = readInviteToken();
      if (!token || (token === accessToken && wsRef.current)) {
        return;
      }
      accessToken = token;
      const hadConnection = wsRef.current !== null;
      disconnect();
      flushIncoming();
      if (hadConnection) {
        onCloseRef.current();
      }
      connect(token);
    };
    window.addEventListener("hashchange", onHashChange);
    connect(accessToken);

    return () => {
      if (incomingFrame !== undefined) {
        cancelAnimationFrame(incomingFrame);
      }
      incoming.length = 0;
      window.removeEventListener("hashchange", onHashChange);
      disconnect();
    };
  }, []);

  // Stable identity: app.tsx memoizes its callbacks on [send], so a fresh
  // function per render would defeat every one of them.
  const send = useCallback((message: ClientMessage): SendStatus => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
      return "sent";
    }
    if (!ws || !QUEUEABLE_OFFLINE.has(message.type)) {
      return "dropped";
    }
    const json = JSON.stringify(message);
    return pendingRef.current.enqueue(json) ? "queued" : "dropped";
  }, []);

  const requestApp: RequestApp = useCallback(
    (appId, operation) => appRequests.current.request(appId, operation, send),
    [send],
  );

  return { send, requestApp };
}
