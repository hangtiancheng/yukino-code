import type { ClientMessage, ServerMessage } from "@browser/types";
import { isServerMessage } from "@browser/types";
import { useCallback, useEffect, useRef } from "react";

import { OfflineMessageQueue } from "./offline-queue";

interface UseWebSocketOptions {
  onMessage: (message: ServerMessage) => void;
  onOpen: () => void;
  onClose: () => void;
}

/** Whether an offline send was delivered, held for replay, or dropped. */
export type SendStatus = "sent" | "queued" | "dropped";

interface UseWebSocketResult {
  send: (message: ClientMessage) => SendStatus;
}

const PING_INTERVAL_MS = 10_000;
// Only a user's chat body is worth replaying after a reconnect. Approvals
// (permission/ask/plan), pings and transient UI actions are stale by the time
// the socket returns — replaying them could re-authorize or re-trigger an old
// request — so they are dropped offline. Image uploads are large and resolve via
// a server reply; the caller reports the drop instead of silently queueing it.
const QUEUEABLE_OFFLINE = new Set<ClientMessage["type"]>(["user_message"]);
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
  const pendingRef = useRef(new OfflineMessageQueue());
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
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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

    // A hash-only navigation (e.g. opening a fresh invite URL after the
    // server restarted with a new token) swaps the token without a page
    // reload; adopt it and reconnect.
    const onHashChange = () => {
      const params = new URLSearchParams(window.location.hash.slice(1));
      const token = params.get("token");
      if (token && token !== accessTokenRef.current) {
        accessTokenRef.current = token;
        window.sessionStorage.setItem(ACCESS_TOKEN_KEY, token);
        window.history.replaceState(
          null,
          "",
          window.location.pathname + window.location.search,
        );
        const ws = wsRef.current;
        if (ws && ws.readyState !== WebSocket.CLOSED) {
          ws.close();
        } else {
          if (reconnectTimer !== null) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }
          connect();
        }
      }
    };
    window.addEventListener("hashchange", onHashChange);

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
        for (const json of pendingRef.current.drain()) {
          ws.send(json);
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
        flushIncoming();
        onCloseRef.current();
        if (pingRef.current) {
          clearInterval(pingRef.current);
          pingRef.current = null;
        }
        if (!disposed) {
          reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
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
        receive(parsed);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (incomingFrame !== undefined) {
        cancelAnimationFrame(incomingFrame);
      }
      incoming.length = 0;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
      }
      window.removeEventListener("hashchange", onHashChange);
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
  const send = useCallback((message: ClientMessage): SendStatus => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
      return "sent";
    }
    if (!QUEUEABLE_OFFLINE.has(message.type)) {
      return "dropped";
    }
    const json = JSON.stringify(message);
    return pendingRef.current.enqueue(json) ? "queued" : "dropped";
  }, []);

  return { send };
}
