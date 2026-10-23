import type { McpAppToolResult, McpAppRequest } from "@yukino.js/mcp/apps.js";
import type { MCPClient } from "@yukino.js/mcp/client.js";
import { buildMcpToolName } from "@yukino.js/mcp/tool-wrapper.js";
import { requestToolPermission } from "@yukino.js/permissions/request.js";
import {
  MCP_APP_EXPIRED,
  MCP_APP_TOOL_UNAVAILABLE,
  MCP_APP_PERMISSION_DENIED,
} from "./constants.js";
import type { RemoteAgentHandle } from "./server.js";
import type { PermissionRequestHandler } from "@yukino.js/tools/types.js";
import { isRecord } from "@yukino.js/utils";

export type McpAppHandle = Pick<
  RemoteAgentHandle,
  "sessionId" | "cwd" | "mcpManager" | "checker" | "toolFilter" | "hookEngine"
>;

export class RemoteMcpApps {
  private apps = new Map<
    string,
    {
      payload: McpAppToolResult;
      client: MCPClient;
      sessionId: string;
    }
  >();
  private requests = new Set<AbortController>();

  register(payload: McpAppToolResult, handle: McpAppHandle): void {
    const client = handle.mcpManager?.getClient(payload.mcpApp.serverName);
    if (client) {
      this.apps.set(payload.toolId, {
        payload,
        client,
        sessionId: handle.sessionId,
      });
    }
  }

  entries(): McpAppToolResult[] {
    return [...this.apps.values()].map(({ payload }) => payload);
  }

  clear(): void {
    this.apps.clear();
    for (const controller of this.requests) {
      controller.abort();
    }
    this.requests.clear();
  }

  async request(
    request: McpAppRequest,
    handle: McpAppHandle,
    onPermissionRequest: PermissionRequestHandler,
    signal: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    this.requests.add(controller);
    const abortSignal = AbortSignal.any([signal, controller.signal]);
    const entry = this.apps.get(request.appId);
    const validate = () => {
      abortSignal.throwIfAborted();
      if (
        entry?.sessionId !== handle.sessionId ||
        handle.mcpManager?.getClient(entry.payload.mcpApp.serverName) !==
          entry.client
      ) {
        throw new Error(MCP_APP_EXPIRED);
      }
      return entry;
    };
    try {
      const {
        payload: { mcpApp: app },
        client,
      } = validate();
      if (request.method === "read_resource") {
        return await client.readResource(request.params.uri, abortSignal);
      }
      const { name, arguments: args = {} } = request.params;
      const tool = client.getTool(name);
      const ui = tool?._meta?.ui;
      const visibility = isRecord(ui) ? ui.visibility : undefined;
      const toolName = buildMcpToolName(app.serverName, name);
      if (
        !tool ||
        (Array.isArray(visibility) && !visibility.includes("app")) ||
        handle.toolFilter?.(toolName) === false
      ) {
        throw new Error(MCP_APP_TOOL_UNAVAILABLE);
      }
      const hook = await handle.hookEngine?.firePreToolHooks(toolName, args, {
        cwd: handle.cwd,
        abortSignal,
      });
      if (hook?.rejected) {
        throw new Error(`Rejected by hook: ${hook.reason}`);
      }
      const decision = handle.checker.check(toolName, "command", args);
      if (decision.effect === "deny") {
        throw new Error(`Permission denied: ${decision.reason}`);
      }
      if (decision.effect === "ask") {
        const patterns = handle.checker.rememberPatterns(toolName, args);
        decision.rememberPatterns = [...patterns];
        const response = await requestToolPermission(
          onPermissionRequest,
          toolName,
          args,
          decision,
          request.requestId,
          abortSignal,
        );
        validate();
        if (response === "deny") {
          throw new Error(MCP_APP_PERMISSION_DENIED);
        }
        if (response === "allowAlways") {
          handle.checker.allowAlways(toolName, args, patterns);
        }
      }
      validate();
      return await client.callToolResult(name, args, abortSignal);
    } finally {
      this.requests.delete(controller);
    }
  }
}
