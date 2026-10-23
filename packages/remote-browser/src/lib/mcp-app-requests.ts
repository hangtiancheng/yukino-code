import type { McpAppRequest } from "@yukino.js/model-context-protocol/apps.js";

import {
  MCP_APP_DISCONNECTED,
  MCP_APP_REQUEST_TIMEOUT,
  MCP_APP_REQUEST_TIMEOUT_MS,
} from "#/constants.js";
import type { ClientMessage, ServerMessage } from "#/types.js";

export type AppOperation = McpAppRequest extends infer R
  ? R extends McpAppRequest
    ? Omit<R, "appId" | "requestId">
    : never
  : never;
export type RequestApp = (
  appId: string,
  operation: AppOperation,
) => Promise<unknown>;

export class McpAppRequests {
  private nextId = 0;
  private pending = new Map<
    string,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  request(
    appId: string,
    operation: AppOperation,
    send: (message: ClientMessage) => string,
  ): Promise<unknown> {
    const requestId = `app_${Date.now().toString(36)}_${String(this.nextId++)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(MCP_APP_REQUEST_TIMEOUT));
      }, MCP_APP_REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      if (
        send({
          type: "mcp_app_request",
          data: { ...operation, appId, requestId },
        }) !== "sent"
      ) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error(MCP_APP_DISCONNECTED));
      }
    });
  }

  receive(message: ServerMessage): boolean {
    if (message.type !== "mcp_app_response") {
      return false;
    }
    const pending = this.pending.get(message.data.requestId);
    if (pending) {
      this.pending.delete(message.data.requestId);
      clearTimeout(pending.timer);
      if (message.data.error) {
        pending.reject(new Error(message.data.error));
      } else {
        pending.resolve(message.data.result);
      }
    }
    return true;
  }

  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(MCP_APP_DISCONNECTED));
    }
    this.pending.clear();
  }
}
