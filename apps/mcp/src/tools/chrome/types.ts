/** A caught exception, recorded by the host logger alongside the message. */
export type LoggerDetail = Error | NodeJS.ErrnoException;

export function toLoggerDetail(detail: unknown): LoggerDetail | undefined {
  return detail instanceof Error ? detail : undefined;
}

/** Logging interface injected by the host; the production adapter maps it onto pino. */
export interface Logger {
  info: (message: string, detail?: LoggerDetail) => void;
  error: (message: string, detail?: LoggerDetail) => void;
  warn: (message: string, detail?: LoggerDetail) => void;
  debug: (message: string, detail?: LoggerDetail) => void;
  silly: (message: string, detail?: LoggerDetail) => void;
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
