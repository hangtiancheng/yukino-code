export const RPC_VERSION = 1;
export const RPC_MAX_LINE_BYTES = 1024 * 1024;
export const RPC_MAX_PENDING_REQUESTS = 64;
export const RPC_MAX_COMMAND_IDS = 100_000;
export const RPC_OUTPUT_DRAIN_TIMEOUT_MS = 30_000;
export const RPC_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const RPC_INTERACTION_TIMEOUT_MS = 300_000;
export const RPC_INTERACTION_LIMIT = 64;
export const RPC_TRANSFER_CHUNK_BYTES = 64 * 1024;
export const RPC_TRANSFER_MAX_BYTES = 64 * 1024 * 1024;
export const RPC_TRANSFER_LIMIT = 4;
export const RPC_TRANSFER_TTL_MS = 300_000;
export const RPC_TRANSFER_TEMP_PREFIX = "yukino-rpc-transfer-";
export const RPC_TRANSFER_HASH_RE = /^[a-f0-9]{64}$/u;
export const RPC_TRANSFER_BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
export const RPC_CONTROL_REQUEST_RESERVE = 8;
export const RPC_CONTROL_COMMANDS = new Set<string>([
  "abort_retry",
  "get_state",
  "get_commands",
  "get_stats",
  "abort",
  "interaction_response",
  "cancel_transfer",
]);
export const RPC_COMMANDS = [
  "reload",
  "get_settings",
  "set_settings",
  "get_available_models",
  "cycle_model",
  "cycle_thinking",
  "set_auto_compaction",
  "set_auto_retry",
  "abort_retry",
  "prompt",
  "steer",
  "follow_up",
  "get_queue",
  "get_queue_modes",
  "set_queue_mode",
  "clear_queue",
  "abort",
  "get_state",
  "get_commands",
  "get_messages",
  "get_entries",
  "get_tree",
  "new_session",
  "switch_session",
  "resume_session",
  "name_session",
  "set_metadata",
  "navigate",
  "label",
  "fork",
  "clone",
  "import_session",
  "export_session",
  "export_session_begin",
  "import_session_begin",
  "read_transfer_chunk",
  "write_transfer_chunk",
  "finish_transfer",
  "cancel_transfer",
  "get_model",
  "set_model",
  "get_thinking",
  "set_thinking",
  "compact",
  "bash",
  "get_stats",
  "get_retry_state",
  "get_code_mode",
  "stop_code_mode",
  "get_warming_state",
  "stop_warming",
  "resume_warming",
  "get_tasks",
  "stop_task",
  "get_workflows",
  "stop_workflow",
  "get_mcp",
  "mcp_resources",
  "mcp_templates",
  "mcp_read",
  "mcp_register",
  "mcp_unregister",
  "mcp_connect",
  "mcp_disconnect",
  "mcp_login",
  "mcp_logout",
  "mcp_exposure",
  "diagnostics",
  "interaction_response",
] as const;
