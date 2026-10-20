// Only warn level and above (warn, error, fatal) are recorded, by design.
export const LOG_LEVEL = "warn";

export const CAUSE_MAX_DEPTH = 5;
export const RESERVED_KEYS = new Set(["name", "message", "stack", "cause"]);
