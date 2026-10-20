/** Heading of announcements that add servers; also the marker history is scanned for. Removal-only deltas do not carry it. */
export const MCP_INSTRUCTIONS_MARKER = "# MCP Server Instructions";

export const MCP_TOOL_PREFIX = "mcp__";
/**
 * Separator between the server segment and the tool segment in a tool name. A double
 * underscore marks the boundary — server names and tool names may themselves contain
 * single underscores.
 */
export const MCP_NAME_SEP = "__";

/** Below this share of the context window, skip deferral and load everything eagerly. */
export const DEFAULT_EAGER_THRESHOLD_PERCENT = 10;

/**
 * Estimation ratio used when real token counts are unavailable. MCP schemas are JSON
 * with high symbol density, so they have fewer characters per token than natural language.
 */
export const CHARS_PER_TOKEN = 2.5;

/** Beta header for official endpoints; defer_loading and tool_reference both require it. */
export const NATIVE_TOOL_USE_BETA = "advanced-tool-use-2025-11-20";

export const OFFICIAL_HOSTS = new Set(["api.anthropic.com"]);
export const ENV_OVERRIDE = "YUKINO_MCP_LOADING";

// MCP image content uses {type:"image", data, mimeType}; providers use
// {type:"image", source:{type:"base64", media_type, data}}. Unsupported mime
// types degrade to a text placeholder.
export const MCP_IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
