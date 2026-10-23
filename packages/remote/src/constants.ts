import { existsSync } from "node:fs";
import { join } from "node:path";

/** Max characters of tool output kept in a log line. */
export const TEXT_PREVIEW_CHARS = 800;
export const MCP_APP_EXPIRED =
  "This app is no longer connected to its MCP server. Generate it again.";
export const MCP_APP_TOOL_UNAVAILABLE =
  "This tool is not available to the app.";
export const MCP_APP_PERMISSION_DENIED = "Permission denied.";
export const MCP_APP_AGENT_DISCONNECTED = "Agent is not connected.";

export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

// Permission/ask requests with no client response settle after this long, so
// a closed browser tab cannot pin the streaming slot (and the run) forever.
export const PENDING_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
export const PENDING_REQUEST_TIMEOUT_MINUTES = 10;

// WS heartbeat: ping interval and the no-pong threshold that terminates a
// half-open connection.
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_STALE_MS = 75_000;

// Activity-bridge cadence: teammate-state diffing and the idle wakeup that
// drains pending task notifications into a notification-only turn.
export const TEAMMATE_POLL_INTERVAL_MS = 500;
export const WAKEUP_POLL_INTERVAL_MS = 250;
/** Delay between the /quit acknowledgement and the actual shutdown. */
export const SHUTDOWN_GRACE_MS = 250;

/** Uploaded images follow the terminal clipboard-image limit. */
export const MAX_UPLOAD_IMAGE_BYTES = 32 * 1024 * 1024;
/** @-mention file cache lifetime (matches the terminal input cache). */
export const FILE_CACHE_TTL_MS = 30_000;

/** Recent input-history entries replayed to a newly connected browser. */
export const INPUT_HISTORY_LIMIT = 200;
/** Sessions offered by the /resume picker. */
export const SESSION_LIST_LIMIT = 50;

export const BROWSER_DIST = [
  join(import.meta.dirname, "browser", "dist"),
  join(import.meta.dirname, "..", "browser", "dist"),
  join(import.meta.dirname, "..", "..", "browser", "dist"),
].find((directory) => existsSync(directory));

export const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};
