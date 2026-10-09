import type { Decision } from "./index.js";

import type {
  PermissionRequestHandler,
  PermissionRequestSource,
} from "@/tools/types.js";

export async function requestToolPermission(
  handler: PermissionRequestHandler,
  toolName: string,
  args: Record<string, unknown>,
  decision: Decision,
  toolCallId: string,
  signal?: AbortSignal,
  source?: PermissionRequestSource,
): ReturnType<PermissionRequestHandler> {
  if (signal?.aborted) {
    return "deny";
  }
  let cancel = (): void => undefined;
  const cancelled = new Promise<"deny">((resolve) => {
    cancel = () => {
      resolve("deny");
    };
    signal?.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([
      handler(toolName, args, decision, toolCallId, signal, source),
      cancelled,
    ]);
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
