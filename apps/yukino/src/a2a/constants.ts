/** Discriminator key inside structured data parts owned by yukino. */
export const YUKINO_DATA_KEY = "yukino";

/** Discriminator values identifying the yukino data part kinds. */
export const PERMISSION_REQUEST_KIND = "permission-request";
export const PERMISSION_RESPONSE_KIND = "permission-response";
export const THINKING_KIND = "thinking";
export const TOOL_CALL_KIND = "tool-call";
export const TOOL_RESULT_KIND = "tool-result";

/** Tool result outputs above this length are truncated in published events. */
export const MAX_TOOL_OUTPUT_LENGTH = 8000;

/** Appended to tool outputs truncated in published events. */
export const TRUNCATION_MARKER = "\n… [truncated]";

/** Idle grace period before an agent runtime is disposed to reclaim resources. */
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Upper bound on tracked contextId sessions. Idle eviction releases a session's
 * runtime but keeps its contextId→sessionId entry so the transcript can be
 * restored; without a cap a long-running server seeing many distinct contextIds
 * would grow that map until dispose(). Overflow drops the least-recently-used
 * fully-idle entries after persisting their context mapping.
 */
export const MAX_TRACKED_SESSIONS = 256;

export const NO_ACTIVE_RUN = "No active run is awaiting a permission response.";

export const MESSAGE_CONTENT_REQUIRED =
  "Message must contain text or a yukino permission-response data part.";

export const SESSION_CLOSED_DURING_INIT =
  "Session closed during initialization.";

export const TASK_CANCELED_TEXT = "Task canceled by user request.";

export function buildContextBusyReason(
  contextId: string,
  taskId: string,
): string {
  return (
    `Context ${contextId} is busy with task ${taskId}. ` +
    "Cancel it or wait for it to finish before sending a new message."
  );
}

export function buildPermissionTaskMismatchReason(taskId: string): string {
  return `Permission responses must be sent with taskId "${taskId}".`;
}

export function buildUnknownPermissionIdReason(permissionId: string): string {
  return `Unknown or already resolved permission id "${permissionId}".`;
}

export const TRANSCRIPT_UNAVAILABLE_ERROR =
  "A2A context transcript is no longer available. Start a new context.";

export const NO_PROVIDER_ERROR = "No provider configured.";

export const SESSION_CAPACITY_ERROR =
  "A2A session capacity reached; retry when an active context finishes.";

export const INVALID_CONTEXT_MAPPING_ERROR =
  "Invalid persisted A2A context mapping.";

export const LOOPBACK_REQUIRED_ERROR =
  "A2A server must listen on a loopback address.";

export const SERVER_NOT_BOUND_ERROR =
  "A2A server did not bind to a TCP address.";

export const A2A_DEFAULT_PORT = 18890;
export const DEFAULT_ADDRESS = `127.0.0.1:${String(A2A_DEFAULT_PORT)}`;
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";
export const A2A_PROTOCOL_VERSION = "1.0";
export const A2A_CONTEXTS_DIR_NAME = "a2a-contexts";

export const DEFAULT_HISTORY_LENGTH = 10;
export const REQUEST_BODY_LIMIT = 100 * 1024;
export const PERMISSION_EXTENSION_URI =
  "https://github.com/hangtiancheng/yukino-code/blob/main/apps/yukino/README.md#yukino-a2a-permissions-v1";
export const A2A_METHODS = new Set([
  "SendMessage",
  "SendStreamingMessage",
  "GetTask",
  "ListTasks",
  "CancelTask",
  "SubscribeToTask",
  "CreateTaskPushNotificationConfig",
  "GetTaskPushNotificationConfig",
  "ListTaskPushNotificationConfigs",
  "DeleteTaskPushNotificationConfig",
  "GetExtendedAgentCard",
]);
export const MISSING_VERSION_ERROR =
  "Missing A2A-Version header; send A2A-Version: 1.0.";
export const REQUEST_TOO_LARGE_ERROR = `Request body exceeds the ${String(REQUEST_BODY_LIMIT)} byte limit.`;
export const MALFORMED_JSON_ERROR = "Request body must contain valid JSON.";
export function unsupportedVersionError(version: string): string {
  return `Unsupported A2A-Version ${JSON.stringify(version)}; this server requires A2A-Version: 1.0.`;
}
export function unknownMethodError(method: string): string {
  return `Unknown method ${JSON.stringify(method)}. Supported methods: ${[...A2A_METHODS].join(", ")}.`;
}
