export const AGENTS_DIR_NAME = ".agents";
export const SKILLS_DIR_NAME = "skills";
export const SKILL_FILE_NAME = "SKILL.md";

export const FRONTMATTER_BLOCK_RE =
  /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
export const SKILL_NAME_RE = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/;

export const MAX_SKILL_DOWNLOAD_BYTES = 1024 * 1024;
export const SKILL_DOWNLOAD_TIMEOUT_MS = 30_000;
export const MAX_SKILL_DESCRIPTION_CHARS = 200;
export const FORK_CONTEXT_RECENT_MESSAGES = 5;
export const FORK_CONTEXT_FULL_MESSAGES = 100;

export const ARGUMENTS_PLACEHOLDER = "$ARGUMENTS";

export const SKILL_DOWNLOAD_TIMEOUT_ERROR =
  "Skill download timed out after 30 seconds";
export const SKILL_DOWNLOAD_TOO_LARGE_ERROR =
  "Skill download exceeds the 1 MiB size limit";
export const SKILL_DOWNLOAD_INVALID_STREAM_ERROR =
  "Skill download returned an invalid response stream";
export const SKILL_DOWNLOAD_INVALID_CHUNK_ERROR =
  "Skill download returned a non-byte response chunk";
export const SOURCE_REQUIRED_ERROR = "Error: source is required";
export const INVALID_SKILL_SOURCE_ERROR =
  "Error: source must be a valid SKILL.md with a frontmatter name";
export const INVALID_SKILL_NAME_ERROR =
  "Error: invalid skill name; use letters, digits, dots, underscores and hyphens";
