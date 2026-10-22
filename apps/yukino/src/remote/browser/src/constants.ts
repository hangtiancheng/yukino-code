import type {
  ClientMessage,
  PermissionModeChoice,
  PermissionResponse,
  ProviderSavePayload,
  RewindChoice,
  ToolItem,
} from "#/types.js";

export const MCP_APP_DEFAULT_HEIGHT = 480;
export const MCP_APP_MIN_HEIGHT = 100;
export const MCP_APP_MAX_HEIGHT = 1200;
export const MCP_APP_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
export const MCP_APP_INITIALIZE_TIMEOUT_MS = 20_000;
export const MCP_APP_LOADING = "Loading app…";
export const MCP_APP_DISCONNECTED =
  "The app is disconnected. Reconnect and try again.";
export const MCP_APP_REQUEST_TIMEOUT = "The app request timed out. Try again.";
export const MCP_APP_INITIALIZE_TIMEOUT =
  "The app did not connect. Retry to load it again.";
export const MCP_APP_HOST_INFO = { name: "Yukino Remote", version: "1.0.0" };
export const MCP_APP_TEARDOWN_TIMEOUT_MS = 500;
export const MCP_APP_RESOURCE_MISSING =
  "The MCP server did not return an app HTML resource.";
export const MCP_APP_FRAME_MISSING = "The app frame is unavailable.";
export const MCP_APP_MESSAGE_FAILED =
  "The message could not be sent. Reconnect and try again.";
export const MCP_APP_LINK_BLOCKED = "Only HTTP and HTTPS links can be opened.";
export const MCP_APP_RETRY = "Retry";

export const MODE_CYCLE: Exclude<PermissionModeChoice, "plan">[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
];

export const MODE_LABEL: Record<string, string> = {
  default: "Default",
  plan: "Plan",
  bypassPermissions: "YOLO",
  acceptEdits: "Accept Edits",
};

export const PROTOCOLS: ProviderSavePayload["protocol"][] = [
  "anthropic",
  "openai",
  "openai-compat",
];

export const RESPONSE_OPTIONS: {
  value: PermissionResponse;
  label: string;
  className: string;
}[] = [
  {
    value: "allow",
    label: "Allow",
    className: "bg-accent text-accent-contrast  hover:bg-accent-dim",
  },
  {
    value: "allowAlways",
    label: "Remember Scopes for All Project Agents",
    className: "border border-accent/40 text-accent hover:bg-accent/8",
  },
  {
    value: "deny",
    label: "Deny",
    className: "border border-red/30 text-red hover:bg-red/6",
  },
];

export const RESPONSE_LABEL: Record<string, string> = {
  allow: "Allowed once",
  allowAlways: "Allowed for all project agents",
  deny: "Denied",
};

export const RESTORE_OPTIONS: { action: RewindChoice; label: string }[] = [
  { action: "code_and_conversation", label: "Restore code and conversation" },
  { action: "conversation_only", label: "Restore conversation only" },
  { action: "code_only", label: "Restore code only" },
];

export const STATUS_META: Record<
  ToolItem["status"],
  { label: string; pill: string; panel: string }
> = {
  running: {
    label: "running…",
    pill: "text-muted",
    panel: "bg-tool",
  },
  ok: {
    label: "✓",
    pill: "text-green",
    panel: "bg-tool-ok",
  },
  err: {
    label: "✗",
    pill: "text-red",
    panel: "bg-tool-error",
  },
};

export const STATUS_PILL: Record<string, string> = {
  running: "bg-yellow/15 text-yellow",
  completed: "bg-green/15 text-green",
  failed: "bg-red/15 text-red",
  stopped: "bg-red/15 text-red",
  cancelled: "bg-red/15 text-red",
  idle: "bg-accent/15 text-accent",
};

export const MAX_TEXTAREA_HEIGHT = 200;
export const FILE_COMPLETE_DEBOUNCE_MS = 150;

export const MAX_PENDING_MESSAGES = 100;
export const MAX_PENDING_BYTES = 1_000_000;

export const PING_INTERVAL_MS = 10_000;
// Only a user's chat body is worth replaying after a reconnect. Approvals
// (permission/ask/plan), pings and transient UI actions are stale by the time
// the socket returns — replaying them could re-authorize or re-trigger an old
// request — so they are dropped offline. Image uploads are large and resolve via
// a server reply; the caller reports the drop instead of silently queueing it.
export const QUEUEABLE_OFFLINE = new Set<ClientMessage["type"]>([
  "user_message",
]);
export const RECONNECT_DELAY_MS = 3_000;
export const ACCESS_TOKEN_KEY = "yukino.remote.accessToken";

export const MAX_CHAT_ITEMS = 1000;

export const STORAGE_KEY = "yukino-theme";
