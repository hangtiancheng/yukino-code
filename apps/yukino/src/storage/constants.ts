export const YUKINO_DIR_NAME = ".yukino";
export const SESSIONS_DIR_NAME = "sessions";
export const ARTIFACTS_DIR_NAME = "artifacts";
export const PROJECTS_DIR_NAME = "projects";

export const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/u;
export const INVALID_SESSION_ID_ERROR = "Invalid session ID";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_STATE_NOT_FILE_ERROR =
  "Private state must be a regular file";

export const PUBLIC_STATE_SEGMENTS = new Set([
  "worktrees",
  "skills",
  "agents",
  "prompts",
  "AGENTS.md",
]);
