import type { Decision } from "@/permissions/index.js";
import type {
  PermissionRequestHandler,
  PermissionRequestSource,
} from "@/tools/types.js";
import { cancelOnSignal } from "@/utils/cancel.js";

export async function requestToolPermission(
  handler: PermissionRequestHandler,
  toolName: string,
  args: Record<string, unknown>,
  decision: Decision,
  toolCallId: string,
  signal?: AbortSignal,
  source?: PermissionRequestSource,
): ReturnType<PermissionRequestHandler> {
  try {
    const response = await cancelOnSignal(
      () => handler(toolName, args, decision, toolCallId, signal, source),
      signal,
    );
    return response === "allowAlways" && !decision.rememberPatterns?.length
      ? "allow"
      : response;
  } catch (error) {
    if (signal?.aborted && error === signal.reason) {
      return "deny";
    }
    throw error;
  }
}
