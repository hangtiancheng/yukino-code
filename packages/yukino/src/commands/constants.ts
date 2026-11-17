export const PROMPTS_DIR_NAME = "prompts";
export const COMMAND_FILE_EXTENSION = ".md";
export const COMMAND_FILE_EXTENSION_RE = /\.md$/;
export const FRONTMATTER_BLOCK_RE =
  /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u;
export const ARGUMENT_PLACEHOLDER_RE =
  /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/gu;
export const CUSTOM_COMMAND_TAG = "[custom]";
export const COMMAND_RECENCY_HALF_LIFE_DAYS = 7;
export const COMMAND_MIN_RECENCY_WEIGHT = 0.1;
export const MILLISECONDS_PER_DAY = 86_400_000;
export const SUBAGENT_COMMAND_UNAVAILABLE = "Agent tool is not available.";
export const SESSION_ACTIVE_MESSAGE =
  "Session is active. Use /resume to list past sessions.";
export const THINKING_LEVEL_CONTROL_UNAVAILABLE =
  "Thinking level control is not available in this context.";
export const REVIEW_COMMAND_DESCRIPTION =
  "Review a pull request: /review [PR number or URL]";
