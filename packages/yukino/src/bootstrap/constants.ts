export const INVOCATION_MAX_TEXT_BYTES = 1024 * 1024;
export const INVOCATION_MAX_ATTACHMENTS = 20;
export const INVOCATION_MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const CRASH_LOG_FILENAME = "crash.log";
export const TERMINAL_GONE_CODES = new Set([
  "EIO",
  "EPIPE",
  "ERR_STREAM_DESTROYED",
]);
