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

/**
 * Optional type for the second Logger argument; in practice this is usually
 * a caught exception object that the host logger records alongside the
 * message.
 */
export type LoggerDetail = Error | NodeJS.ErrnoException;

/** Narrow unknown to LoggerDetail, for catch blocks to pass to the logger. */
export function toLoggerDetail(detail: unknown): LoggerDetail | undefined {
  return detail instanceof Error ? detail : undefined;
}

/** Logging interface injected by the host; the production adapter maps it onto pino. */
export interface Logger {
  info: (message: string, detail?: LoggerDetail) => void; // informational
  error: (message: string, detail?: LoggerDetail) => void; // error
  warn: (message: string, detail?: LoggerDetail) => void; // warning
  debug: (message: string, detail?: LoggerDetail) => void; // debug
  silly: (message: string, detail?: LoggerDetail) => void; // most verbose level
}

export interface YukinoForChromeContext {
  serverName: string;
  logger: Logger;
  socketPath: string;
  // Optional dynamic resolver for socket path. When provided, called on each
  // connection attempt to handle runtime conditions (e.g., TMPDIR mismatch).
  getSocketPath?: () => string;
  // Optional resolver returning all available socket paths (for multi-profile support).
  // When provided, a socket pool connects to all sockets and routes by tab ID.
  getSocketPaths?: () => string[];
  clientTypeId: "desktop" | "claude-code";
  onToolCallDisconnected: () => string;
  isDisabled?: () => boolean;
}

/** Shared interface for McpSocketClient and McpSocketPool */
export interface SocketClient {
  ensureConnected(): Promise<boolean>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  isConnected(): boolean;
  disconnect(): void;
  setNotificationHandler(
    handler: (notification: {
      method: string;
      params?: Record<string, unknown>;
    }) => void,
  ): void;
}
