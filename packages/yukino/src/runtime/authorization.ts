import { randomUUID } from "node:crypto";

import type { ToolInvocationEntry } from "@/mcp/policy.js";
import { requestToolPermission } from "@/permissions/request.js";
import type { AgentRuntime } from "@/runtime/types.js";
import type { PermissionRequestHandler, ToolContext } from "@/tools/types.js";

export async function authorizeRuntimeTool(
  runtime: AgentRuntime,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  permission: PermissionRequestHandler,
  entry: ToolInvocationEntry = "direct",
): Promise<ToolContext> {
  signal.throwIfAborted();
  const cwd = runtime.checker.cwd;
  const tool = runtime.registry.get(name);
  if (
    !tool ||
    !runtime.registry.canInvoke(name, entry) ||
    runtime.toolFilter?.(name) === false
  ) {
    throw new Error(`Tool ${name} is excluded from this session`);
  }
  const category = tool.category;
  args = tool.permissionArguments?.(args) ?? args;
  const initialDecision = runtime.checker.check(name, category, args);
  if (initialDecision.effect === "deny") {
    throw new Error(initialDecision.reason || "Permission denied");
  }
  const authorization = runtime.registry.captureAuthorization(name, entry);
  const validate = () => {
    signal.throwIfAborted();
    if (
      runtime.registry.get(name) !== tool ||
      runtime.checker.cwd !== cwd ||
      tool.category !== category ||
      !runtime.registry.validateAuthorization(authorization) ||
      runtime.toolFilter?.(name) === false ||
      runtime.checker.check(name, category, args).effect === "deny"
    ) {
      throw new Error(
        "Operation authorization changed while approval was pending",
      );
    }
  };
  const hook = await runtime.hookEngine?.firePreToolHooks(name, args, {
    cwd,
    abortSignal: signal,
  });
  if (hook?.rejected) {
    throw new Error("Operation rejected by hook");
  }
  validate();
  const decision = runtime.checker.check(name, category, args);
  const toolCallId = randomUUID();
  if (decision.effect === "ask") {
    const patterns = runtime.checker.rememberPatterns(name, args);
    decision.rememberPatterns = [...patterns];
    const response = await requestToolPermission(
      permission,
      name,
      args,
      decision,
      toolCallId,
      signal,
    );
    if (response === "deny") {
      throw new Error(decision.reason || "Permission denied");
    }
    validate();
    if (response === "allowAlways") {
      runtime.checker.allowAlways(name, args, patterns);
    }
  }
  validate();
  return {
    invocationEntry: entry,
    approvedPermissionMode: runtime.checker.mode,
    cwd,
    sessionId: runtime.sessionId,
    toolCallId,
    abortSignal: signal,
    permissionChecker: runtime.checker,
    onPermissionRequest: permission,
    taskManager: runtime.backgroundTaskManager,
  };
}
