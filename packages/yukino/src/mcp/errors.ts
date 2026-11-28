import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import type { MCPServerConfig } from "@/mcp/config.js";
import {
  MCP_CONNECTION_CODES,
  MCP_CONNECTION_ERROR_NAME,
  MCP_CONNECTION_MESSAGES,
  MCP_DIAGNOSTIC_CAUSE_DEPTH,
  MCP_DIAGNOSTIC_SERVER_LIMIT,
  MCP_DIAGNOSTIC_SERVER_PATTERN,
  MCP_UNAVAILABLE_HTTP_STATUSES,
  MCP_UNAVAILABLE_NETWORK_CODES,
  MCP_UNAVAILABLE_STDIO_CODES,
} from "@/mcp/constants.js";

export type MCPConnectionPhase = "connect" | "discovery" | "publication";
export interface MCPConnectionDiagnostic {
  readonly serverName: string;
  readonly transport: "stdio" | "http";
  readonly phase: MCPConnectionPhase;
  readonly code?: string;
  readonly httpStatus?: number;
  readonly message: string;
}

type ConnectionConfig = Pick<MCPServerConfig, "name" | "command" | "transport">;

function recognizedFailure(
  cause: unknown,
  transport: MCPConnectionDiagnostic["transport"],
  depth = 0,
): { code?: string; httpStatus?: number; message: string } | undefined {
  if (cause instanceof UnauthorizedError) {
    return {
      code: MCP_CONNECTION_CODES.auth,
      httpStatus: 401,
      message: MCP_CONNECTION_MESSAGES.auth,
    };
  }
  if (cause instanceof DOMException && cause.name === "TimeoutError") {
    return {
      code: MCP_CONNECTION_CODES.timeout,
      message: MCP_CONNECTION_MESSAGES.timeout,
    };
  }
  if (cause instanceof McpError) {
    const timeoutCode: number = ErrorCode.RequestTimeout;
    const closedCode: number = ErrorCode.ConnectionClosed;
    if (cause.code === timeoutCode) {
      return {
        code: MCP_CONNECTION_CODES.timeout,
        message: MCP_CONNECTION_MESSAGES.timeout,
      };
    }
    if (cause.code === closedCode) {
      return {
        code: MCP_CONNECTION_CODES.closed,
        message: MCP_CONNECTION_MESSAGES.closed,
      };
    }
  }
  if (cause instanceof StreamableHTTPError) {
    const status = cause.code;
    if (
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 400 &&
      status <= 599
    ) {
      return {
        httpStatus: status,
        message:
          status === 401 || status === 403
            ? MCP_CONNECTION_MESSAGES.auth
            : MCP_UNAVAILABLE_HTTP_STATUSES.has(status)
              ? MCP_CONNECTION_MESSAGES.unavailable
              : MCP_CONNECTION_MESSAGES.rejected,
      };
    }
  }
  if (
    cause instanceof Error &&
    "code" in cause &&
    typeof cause.code === "string"
  ) {
    const codes =
      transport === "stdio"
        ? MCP_UNAVAILABLE_STDIO_CODES
        : MCP_UNAVAILABLE_NETWORK_CODES;
    if (codes.has(cause.code)) {
      return { code: cause.code, message: MCP_CONNECTION_MESSAGES.unavailable };
    }
  }
  if (cause instanceof TypeError && depth < MCP_DIAGNOSTIC_CAUSE_DEPTH) {
    return recognizedFailure(cause.cause, transport, depth + 1);
  }
  return undefined;
}

export class MCPConnectionError extends Error {
  override readonly name = MCP_CONNECTION_ERROR_NAME;
  readonly diagnostic: MCPConnectionDiagnostic;
  readonly optionalUnavailable: boolean;

  constructor(
    config: ConnectionConfig,
    phase: MCPConnectionPhase,
    cause: unknown,
  ) {
    const transport = config.command ? "stdio" : "http";
    const recognized =
      phase === "publication" ? undefined : recognizedFailure(cause, transport);
    const message = recognized?.message ?? MCP_CONNECTION_MESSAGES[phase];
    super(message, { cause });
    this.diagnostic = Object.freeze({
      serverName: config.name
        .replace(MCP_DIAGNOSTIC_SERVER_PATTERN, "_")
        .slice(0, MCP_DIAGNOSTIC_SERVER_LIMIT),
      transport,
      phase,
      ...recognized,
      message,
    });
    this.optionalUnavailable =
      recognized !== undefined &&
      (recognized.httpStatus === undefined ||
        recognized.httpStatus === 401 ||
        recognized.httpStatus === 403 ||
        MCP_UNAVAILABLE_HTTP_STATUSES.has(recognized.httpStatus));
  }
}

export function isOptionalMCPConnectionError(
  error: unknown,
): error is MCPConnectionError {
  return error instanceof MCPConnectionError && error.optionalUnavailable;
}

export function mcpConnectionError(
  config: ConnectionConfig,
  phase: MCPConnectionPhase,
  error: unknown,
  signal?: AbortSignal,
): unknown {
  if (signal?.aborted) {
    return signal.reason;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return error;
  }
  return error instanceof MCPConnectionError
    ? error
    : new MCPConnectionError(config, phase, error);
}
