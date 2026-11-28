import type { McpAppToolResult, McpAppRequest } from "@/mcp/apps.js";
import type { MCPClient } from "@/mcp/client.js";
import { MCP_RESOURCE_READ_TOOL } from "@/mcp/constants.js";
import { buildMcpToolName } from "@/mcp/tool-wrapper.js";
import { requestToolPermission } from "@/permissions/request.js";
import {
  MCP_APP_EXPIRED,
  MCP_APP_TOOL_UNAVAILABLE,
  MCP_APP_PERMISSION_DENIED,
} from "@/remote/constants.js";
import type { AgentRuntime } from "@/runtime/types.js";
import type { PermissionRequestHandler } from "@/tools/types.js";
import { isRecord } from "@/utils/record.js";

export type McpAppHandle = Pick<
  AgentRuntime,
  | "sessionId"
  | "cwd"
  | "mcpManager"
  | "checker"
  | "toolFilter"
  | "hookEngine"
  | "registry"
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
      const resource = request.method === "read_resource";
      const name = resource ? MCP_RESOURCE_READ_TOOL : request.params.name;
      const args = resource
        ? { server: app.serverName, uri: request.params.uri }
        : (request.params.arguments ?? {});
      const tool = resource ? undefined : client.getTool(name);
      const ui = tool?._meta?.ui;
      const visibility = isRecord(ui) ? ui.visibility : undefined;
      const toolName = resource ? name : buildMcpToolName(app.serverName, name);
      const invocationEntry = resource ? "resource" : "app";
      if (
        (resource
          ? !handle.mcpManager?.canReadResources(app.serverName)
          : !tool) ||
        (!resource &&
          Array.isArray(visibility) &&
          !visibility.includes("app")) ||
        handle.toolFilter?.(toolName) === false ||
        !handle.registry.canInvoke(toolName, invocationEntry)
      ) {
        throw new Error(MCP_APP_TOOL_UNAVAILABLE);
      }
      const authorization = handle.registry.captureAuthorization(
        toolName,
        invocationEntry,
      );
      const validateAccess = () => {
        validate();
        if (
          !handle.registry.validateAuthorization(authorization) ||
          (resource && !handle.mcpManager?.canReadResources(app.serverName))
        ) {
          throw new Error(MCP_APP_TOOL_UNAVAILABLE);
        }
      };
      const hook = await handle.hookEngine?.firePreToolHooks(toolName, args, {
        cwd: handle.cwd,
        abortSignal,
      });
      if (hook?.rejected) {
        throw new Error(`Rejected by hook: ${hook.reason}`);
      }
      validateAccess();
      const decision = handle.checker.check(
        toolName,
        resource ? "read" : "command",
        args,
      );
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
        validateAccess();
        if (response === "deny") {
          throw new Error(MCP_APP_PERMISSION_DENIED);
        }
        if (response === "allowAlways") {
          handle.checker.allowAlways(toolName, args, patterns);
        }
      }
      validateAccess();
      const result =
        request.method === "read_resource"
          ? await client.readResource(request.params.uri, abortSignal)
          : await client.callToolResult(name, args, abortSignal, "app");
      validateAccess();
      return result;
    } finally {
      this.requests.delete(controller);
    }
  }
}
