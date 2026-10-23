export const JSONRPC_VERSION = "2.0";
export const CONTENT_LENGTH_HEADER = "Content-Length";
export const CONTENT_LENGTH_HEADER_PATTERN = /^Content-Length:\s*(\d+)\s*$/gimu;
export const HEADER_DELIMITER = "\r\n\r\n";

export const MAX_HEADER_BYTES = 8192;
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const MAX_STDERR_CHARS = 4000;

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const SHUTDOWN_TIMEOUT_MS = 500;
export const KILL_DELAY_MS = 500;

export const METHOD_INITIALIZE = "initialize";
export const METHOD_INITIALIZED = "initialized";
export const METHOD_SHUTDOWN = "shutdown";
export const METHOD_EXIT = "exit";
export const METHOD_CANCEL_REQUEST = "$/cancelRequest";
export const METHOD_DID_CHANGE_CONFIGURATION =
  "workspace/didChangeConfiguration";
export const METHOD_APPLY_EDIT = "workspace/applyEdit";
export const METHOD_CONFIGURATION = "workspace/configuration";
export const METHOD_WORKSPACE_FOLDERS = "workspace/workspaceFolders";
export const METHOD_SHOW_MESSAGE_REQUEST = "window/showMessageRequest";
export const METHOD_WORK_DONE_PROGRESS_CREATE =
  "window/workDoneProgress/create";
export const METHOD_NOT_FOUND_ERROR_CODE = -32601;

export const CLIENT_NAME = "yukino";
export const POSITION_ENCODING_UTF16 = "utf-16";

export const REQUEST_INTERRUPTED_ERROR = "LSP request interrupted";
export const HEADER_TOO_LARGE_ERROR = "LSP header exceeds 8KB";
export const CONTENT_LENGTH_EXPECTED_ERROR =
  "Expected one Content-Length header";
export const MESSAGE_TOO_LARGE_ERROR = "LSP message exceeds 16MB";
export const INVALID_JSONRPC_ERROR = "Invalid JSON-RPC message";
export const REQUEST_FAILED_ERROR = "LSP request failed";
export const UNSUPPORTED_METHOD_ERROR = "Unsupported read-only client method";
export const APPLY_EDIT_FAILURE_REASON =
  "Yukino LSP is read-only; use authorized file tools for edits.";
export const INVALID_INITIALIZE_RESPONSE_ERROR =
  "Invalid LSP initialize response";
export const UNSUPPORTED_POSITION_ENCODING_ERROR =
  "Only UTF-16 LSP positions are supported";
export const CLIENT_DISPOSED_ERROR = "LSP client disposed";

export const FILE_EXTENSION_PATTERN = /^\.[\w-]+$/u;
export const FILE_EXTENSION_REQUIRED_ERROR =
  "At least one file extension is required";
