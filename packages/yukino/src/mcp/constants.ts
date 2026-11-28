/** Heading of announcements that add servers; also the marker history is scanned for. Removal-only deltas do not carry it. */
export const MCP_INSTRUCTIONS_MARKER = "# MCP Server Instructions";

export const MCP_TOOL_PREFIX = "mcp__";
export const MCP_APPS_EXTENSION = "io.modelcontextprotocol/ui";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
export const MCP_APP_URI_PREFIX = "ui://";
/**
 * Separator between the server segment and the tool segment in a tool name. A double
 * underscore marks the boundary — server names and tool names may themselves contain
 * single underscores.
 */
export const MCP_NAME_SEP = "__";

/** Beta header for official endpoints; defer_loading and tool_reference both require it. */
export const NATIVE_TOOL_USE_BETA = "advanced-tool-use-2025-11-20";

export const OFFICIAL_HOSTS = new Set(["api.anthropic.com"]);

// MCP image content uses {type:"image", data, mimeType}; providers use
// {type:"image", source:{type:"base64", media_type, data}}. Unsupported mime
// types degrade to a text placeholder.
export const MCP_IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export const MCP_NOT_CONNECTED_ERROR = "Not connected";
export const MCP_REQUEST_TIMEOUT_MS = 30_000;
export const MCP_MAX_PAGES = 100;
export const MCP_MAX_LIST_ITEMS = 10_000;
export const MCP_MAX_CURSOR_BYTES = 4096;
export const MCP_RESOURCE_CURSOR_PREFIX = "yukino-page:";
export const MCP_RESOURCE_MAX_BYTES = 8 * 1024 * 1024;
export const MCP_RESOURCE_PREVIEW_BYTES = 16 * 1024;
export const MCP_RESOURCE_MAX_CONTENTS = 100;
export const MCP_OAUTH_CALLBACK_TTL_MS = 5 * 60_000;
export const MCP_OAUTH_REFRESH_SKEW_MS = 30_000;
export const MCP_OAUTH_STORE_VERSION = 1;
export const MCP_OAUTH_CALLBACK_PATH = "/mcp/oauth/callback";
export const MCP_OAUTH_REQUIRED =
  "MCP OAuth login required; automatic login is disabled";
export const MCP_CONNECTION_ERROR_NAME = "MCPConnectionError";
export const MCP_CONNECTION_CODES = {
  auth: "AUTH_REQUIRED",
  timeout: "TIMEOUT",
  closed: "CONNECTION_CLOSED",
} as const;
export const MCP_CONNECTION_MESSAGES = {
  connect: "MCP connection failed",
  discovery: "MCP tool discovery failed",
  publication: "MCP tool publication failed",
  unavailable: "MCP transport is unavailable",
  timeout: "MCP connection timed out",
  closed: "MCP connection closed",
  rejected: "MCP endpoint rejected the request",
  auth: "MCP authentication required; automatic login is disabled",
} as const;
export const MCP_UNAVAILABLE_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
export const MCP_UNAVAILABLE_STDIO_CODES = new Set(["ENOENT", "EPIPE"]);
export const MCP_UNAVAILABLE_HTTP_STATUSES = new Set([
  408, 429, 500, 502, 503, 504,
]);
export const MCP_DIAGNOSTIC_CAUSE_DEPTH = 4;
export const MCP_DIAGNOSTIC_SERVER_LIMIT = 128;
export const MCP_DIAGNOSTIC_SERVER_PATTERN = /[^a-zA-Z0-9_.-]/gu;
export const SDK_UNKNOWN_MCP_ERROR = "MCP server is not connected";
export const SDK_MCP_RESOURCE_RECORD = "mcp_resource";
export const MCP_RESOURCE_LIST_TOOL = "McpResources";
export const MCP_RESOURCE_READ_TOOL = "McpReadResource";
export const MCP_RESOURCE_URI_LIMIT = 8192;
export const MCP_COMMAND_PAGE_SIZE = 2;
export const MCP_COMMAND_LABEL_LIMIT = 160;
export const MCP_COMMAND_INPUT_LIMIT = 32 * 1024;
export const MCP_COMMAND_TEMPLATE_VARIABLE_LIMIT = 32;
export const MCP_COMMAND_ARRAY_LIMIT = 64;
export const MCP_COMMAND_CANCEL = "Cancel";
export const MCP_COMMAND_NEXT = "Next";
export const MCP_COMMAND_READ = "Read";
export const MCP_COMMAND_APPLY = "Apply";
export const MCP_COMMAND_WAIT = "Wait for loopback callback";
export const MCP_COMMAND_VALUE = "Enter value via Other";
export const MCP_COMMAND_EMPTY = "Use empty string";
export const MCP_COMMAND_CANCELLED = "MCP command cancelled.";
export const MCP_COMMAND_NO_SERVERS = "No MCP servers registered.";
export const MCP_COMMAND_NO_RESOURCES = "No MCP resources on this page.";
export const MCP_COMMAND_NO_TEMPLATES = "No MCP URI templates on this page.";
export const MCP_COMMAND_SELECT_SERVER = "Select an MCP server";
export const MCP_COMMAND_SELECT_RESOURCE = "Select an MCP resource";
export const MCP_COMMAND_SELECT_TEMPLATE = "Select an MCP URI template";
export const MCP_COMMAND_STALE =
  "MCP authorization or server configuration changed; start a new command.";
export const MCP_COMMAND_INVALID =
  "Invalid MCP command or arguments. Use /mcp help.";
export const MCP_COMMAND_GLOBAL_RELOAD =
  "Bare /mcp reload is a host-global rebuild; the host must handle it.";
export const MCP_COMMAND_UNKNOWN_SERVER =
  "Unknown MCP server. Use /mcp status.";
export const MCP_COMMAND_INVALID_ANSWER =
  "Invalid MCP selection; no action was applied.";
export const MCP_COMMAND_INVALID_TEMPLATE =
  "Invalid or oversized MCP URI template parameters.";
export const MCP_COMMAND_INVALID_URI =
  "Invalid MCP resource URI; Apps resources require the dedicated Apps host.";
export const MCP_COMMAND_INVALID_OAUTH =
  "Invalid, expired, or wrong-session MCP OAuth callback.";
export const MCP_COMMAND_FAILED =
  "MCP command failed, was denied, or authorization was revoked. No automatic retry.";
export const MCP_COMMAND_OAUTH_PROTOCOLS = new Set(["https:", "http:"]);
export const MCP_COMMAND_LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "[::1]",
  "localhost",
]);
export const MCP_COMMAND_TEMPLATE_EXPRESSION = /\{([^{}]+)\}/gu;
export const MCP_COMMAND_TEMPLATE_VARIABLE =
  /^(?:[A-Za-z0-9_]|%[0-9a-fA-F]{2})+(?:\.(?:[A-Za-z0-9_]|%[0-9a-fA-F]{2})+)*$/u;
export const MCP_COMMAND_TEMPLATE_OPERATORS = new Set([
  "",
  "+",
  "#",
  ".",
  "/",
  ";",
  "?",
  "&",
]);
export const MCP_COMMAND_DIAGNOSTIC_PHASES = new Set([
  "connect",
  "discovery",
  "publication",
]);
export const MCP_COMMAND_HELP = [
  "MCP commands:",
  "/mcp [status [server]] — status only; never connects or retries",
  "/mcp connect|disconnect|login|logout [server]",
  "/mcp reload <server> — reload one server; bare reload is host-global",
  "/mcp resources|templates [server] — pick, preview URI, then explicitly read",
  "/mcp read [server] <uri>",
  "/mcp exposure [server] direct|deferred|codemode|hidden [tool-rule] — confirm before applying",
  "Quote names containing spaces. Omitted servers use the existing AskUser dock.",
  "Login displays the returned authorization URL; no browser opens automatically. Paste a full callback URL via Other, wait for loopback, or cancel.",
  "Resource results stay host-facing; reading does not automatically add model input.",
].join("\n");
export const MCP_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
