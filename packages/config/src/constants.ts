import type { ThinkingLevel } from "./provider-config.js";

/**
 * PI-equivalent thinking levels. `off` disables reasoning entirely; the rest
 * map to a provider-native effort string (openai / openai-compat, and
 * anthropic in adaptive mode) or a thinking token budget (anthropic in budget
 * mode).
 */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "high";
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
/**
 * Fallback output-token ceiling used when `max_output_tokens` is unset (PI's
 * custom-model `maxTokens` default).
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 128_000;

/**
 * PI-equivalent thinking token budgets, used by the anthropic budget-based
 * thinking path. Must stay below DEFAULT_MAX_OUTPUT_TOKENS so the answer keeps
 * room after the thinking budget is reserved.
 */
export const THINKING_BUDGETS: Record<Exclude<ThinkingLevel, "off">, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 65536,
};

export const MIN_THINKING_BUDGET_TOKENS = 1024;
export const MIN_THINKING_ANSWER_TOKENS = 1024;

export const ENV_KEY_MAP = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "openai-compat": "OPENAI_API_KEY",
};

export const VALID_PROTOCOLS = new Set(Object.keys(ENV_KEY_MAP));

export const MCP_LOADING_MODES = [
  "auto",
  "eager",
  "native",
  "dispatch",
] as const;
export const THEME_MODES = ["auto", "dark", "light"] as const;

export const GLOBAL_CONFIG_FILENAME = "config.yaml";
/** Project-level MCP config file, compatible with the Claude Code format. */
export const PROJECT_MCP_FILENAME = ".mcp.json";

export const NO_PROVIDERS_ERROR = "At least one provider MUST be configured.";
export const YAML_PARSE_ERROR = "YAML parse error";
