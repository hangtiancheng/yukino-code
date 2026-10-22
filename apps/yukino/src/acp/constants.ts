export const SESSION_ID_PATTERN = /^[a-z0-9]+-[a-f0-9]{8}$/u;

export const ACP_PATH = "/acp";
export const ACP_WS_DEFAULT_PORT = 18889;
export const DEFAULT_ADDRESS = `127.0.0.1:${String(ACP_WS_DEFAULT_PORT)}`;

export const AGENT_NAME = "yukino";
export const AGENT_TITLE = "Yukino";

export const SESSION_UPDATE_TOOL_CALL = "tool_call";
export const SESSION_UPDATE_TOOL_CALL_UPDATE = "tool_call_update";
export const SESSION_UPDATE_AGENT_MESSAGE_CHUNK = "agent_message_chunk";
export const SESSION_UPDATE_AGENT_THOUGHT_CHUNK = "agent_thought_chunk";
export const SESSION_UPDATE_USER_MESSAGE_CHUNK = "user_message_chunk";
export const SESSION_UPDATE_USAGE_UPDATE = "usage_update";

export const STOP_REASON_END_TURN = "end_turn";
export const STOP_REASON_CANCELLED = "cancelled";
export const STOP_REASON_MAX_TOKENS = "max_tokens";
export const STOP_REASON_MAX_TURN_REQUESTS = "max_turn_requests";
export const STOP_REASON_REFUSAL = "refusal";

export const NO_PROVIDER_ERROR = "No provider configured.";
export const SESSION_CWD_NOT_ABSOLUTE_ERROR = "Session cwd must be absolute.";
export const INVALID_SESSION_ID_ERROR = "Invalid session ID.";
export const CLIENT_MCP_SERVERS_UNSUPPORTED_ERROR =
  "Client-provided MCP servers are not supported.";
export const ADDITIONAL_DIRECTORIES_UNSUPPORTED_ERROR =
  "Additional workspace directories are not supported.";
export const SESSION_CWD_MISMATCH_ERROR = "Session cwd does not match.";
export const SESSION_PAGINATION_UNSUPPORTED_ERROR =
  "Session pagination is not supported.";
export const BINARY_RESOURCE_UNSUPPORTED_ERROR =
  "Binary resources are not supported.";
export const IMAGE_PROMPT_UNSUPPORTED_ERROR =
  "Image prompts are not supported.";
export const AUDIO_PROMPT_UNSUPPORTED_ERROR =
  "Audio prompts are not supported.";
export const EMPTY_PROMPT_ERROR =
  "Prompt must contain text or a resource link.";
export const LOOPBACK_ADDRESS_REQUIRED_ERROR =
  "ACP WebSocket must listen on a loopback address.";
export const TCP_BIND_FAILED_ERROR =
  "ACP WebSocket server did not bind to a TCP address.";
