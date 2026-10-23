// Only warn level and above (warn, error, fatal) are recorded, by design.
export const LOG_LEVEL = "warn";
export const SILENT_LOG_LEVEL = "silent";

export const LOGS_DIR_NAME = "logs";
export const LOG_FILE_EXTENSION = ".jsonl";
export const LOG_EXPIRY_DAYS = 30;

export const UNSAFE_NAME_SEGMENT_PATTERN = /[^a-zA-Z0-9_-]/g;
export const DEFAULT_NAME_SEGMENT = "unnamed";

export const CAUSE_MAX_DEPTH = 5;
export const RESERVED_KEYS = new Set(["name", "message", "stack", "cause"]);
