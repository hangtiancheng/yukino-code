/** Discriminator key inside structured data parts owned by yukino. */
export const YUKINO_DATA_KEY = "yukino";

/** Tool result outputs above this length are truncated in published events. */
export const MAX_TOOL_OUTPUT_LENGTH = 8000;

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

export const A2A_DEFAULT_PORT = 18890;
export const DEFAULT_ADDRESS = `127.0.0.1:${String(A2A_DEFAULT_PORT)}`;
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
