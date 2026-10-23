import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

export const WEBSOCKET_TOKEN_PARAM = "token";

export type WebSocketAuthorization =
  | { allowed: true }
  | { allowed: false; status: 401 | 403 | 404; message: string };

export function createWebSocketAccessToken(): string {
  return randomBytes(32).toString("base64url");
}

function tokensEqual(expected: string, provided: string | null): boolean {
  if (!provided) {
    return false;
  }
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return (
    expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes)
  );
}

function hasAllowedOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) {
    return true;
  }
  const host = request.headers.host;
  if (!host) {
    return false;
  }
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && parsed.host === host;
  } catch {
    return false;
  }
}

export function authorizeWebSocketRequest(
  request: IncomingMessage,
  expectedPath: string,
  accessToken: string,
): WebSocketAuthorization {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname !== expectedPath) {
    return { allowed: false, status: 404, message: "Not Found" };
  }
  if (!tokensEqual(accessToken, url.searchParams.get(WEBSOCKET_TOKEN_PARAM))) {
    return { allowed: false, status: 401, message: "Unauthorized" };
  }
  if (!hasAllowedOrigin(request)) {
    return { allowed: false, status: 403, message: "Forbidden" };
  }
  return { allowed: true };
}

export function rejectWebSocketUpgrade(
  socket: Duplex,
  authorization: Exclude<WebSocketAuthorization, { allowed: true }>,
): void {
  const body = authorization.message + "\n";
  socket.end(
    `HTTP/1.1 ${String(authorization.status)} ${authorization.message}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${String(Buffer.byteLength(body))}\r\n\r\n` +
      body,
  );
}

export function addWebSocketToken(url: string, accessToken: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(WEBSOCKET_TOKEN_PARAM, accessToken);
  return parsed.toString();
}
