/**
 * Leaf module for the provider-config domain: the global config path, the
 * provider schema, and the thinking-level machinery. It must not import the
 * config barrel (./index.js) or provider-login, so both of those can depend
 * on it without creating an evaluation cycle — provider-login builds its zod
 * schema from these values at module scope, which previously TDZ-crashed the
 * nested `Config.ProviderLogin` re-export.
 */

import { z } from "zod";

import { yukinoPath } from "@/storage/paths.js";

export function globalConfigPath(): string {
  return yukinoPath("config.yaml");
}

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

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const ReasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const AnthropicEffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

// Partial overrides: absent entries retain the default mapping; null disables a
// level. Off always disables thinking and cannot be mapped to an enabled effort.
const ThinkingLevelMapSchema = z.strictObject({
  off: z.literal("none").nullable().optional(),
  minimal: ReasoningEffortSchema.nullable().optional(),
  low: ReasoningEffortSchema.nullable().optional(),
  medium: ReasoningEffortSchema.nullable().optional(),
  high: ReasoningEffortSchema.nullable().optional(),
  xhigh: ReasoningEffortSchema.nullable().optional(),
  max: ReasoningEffortSchema.nullable().optional(),
});

export const ProviderConfigSchema = z.looseObject({
  name: z.string(),
  protocol: z.enum(["anthropic", "openai", "openai-compat"]),
  base_url: z.string(),
  model: z.string(),
  api_key: z.string().optional(),
  thinking: z.enum(THINKING_LEVELS).optional(),
  /** Explicit capability metadata, never inferred from model names. */
  reasoning: z.boolean().optional(),
  thinking_level_map: ThinkingLevelMapSchema.optional(),
  /** Only Anthropic uses this mode; existing configurations use budgets. */
  thinking_mode: z.enum(["budget", "adaptive"]).optional(),
  context_window: z.coerce.number().optional(),
  /**
   * The model's output ceiling (PI's `model.maxTokens`). Clamped to the
   * context window; reasoning shares this ceiling instead of raising it.
   */
  max_output_tokens: z.coerce.number().optional(),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/**
 * The provider selected by `default_provider`, falling back to the first
 * entry when the recorded index is out of range (e.g. a hand-edited config).
 * Callers guarantee a non-empty list (loadConfig validates it).
 */
export function resolveDefaultProvider(
  providers: ProviderConfig[],
  defaultProvider: number,
): ProviderConfig {
  return providers[defaultProvider] ?? providers[0];
}

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

export function isValidThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_LEVELS.some((level) => level === value);
}

/** Resolve the effective logical level, including explicit capability limits. */
export function getThinkingLevel(provider: ProviderConfig): ThinkingLevel {
  return clampThinkingLevel(
    provider,
    provider.thinking ?? DEFAULT_THINKING_LEVEL,
  );
}

/** Thinking token budget for a level; 0 when thinking is off. */
export function thinkingBudgetForLevel(level: ThinkingLevel): number {
  return level === "off" ? 0 : THINKING_BUDGETS[level];
}

/** Map a logical level using configured capabilities, not model-name guesses. */
export function toReasoningEffort(
  level: ThinkingLevel,
  provider?: ProviderConfig,
): z.infer<typeof ReasoningEffortSchema> | null {
  if (provider?.reasoning === false) {
    return null;
  }
  // Omitting reasoning can enable a server default. Off must explicitly disable
  // it, even when an off:null override was provided.
  if (level === "off") {
    return "none";
  }
  const mapped = provider?.thinking_level_map?.[level];
  if (mapped !== undefined) {
    return mapped;
  }
  if (
    provider?.protocol === "anthropic" &&
    provider.thinking_mode === "adaptive"
  ) {
    if (level === "minimal") {
      return "low";
    }
    if (level === "xhigh") {
      return "high";
    }
  }
  // The openai protocols have no native xhigh/max: sending them verbatim is a
  // guaranteed 400. Collapse to the nearest legal effort; providers whose
  // gateways accept richer values configure them via thinking_level_map.
  if (
    (provider?.protocol === "openai" ||
      provider?.protocol === "openai-compat") &&
    (level === "xhigh" || level === "max")
  ) {
    return "high";
  }
  return level;
}

/** Narrow adaptive efforts to the Anthropic SDK's legal values. */
export function toAnthropicThinkingEffort(
  level: ThinkingLevel,
  provider: ProviderConfig,
): z.infer<typeof AnthropicEffortSchema> | null {
  const parsed = AnthropicEffortSchema.safeParse(
    toReasoningEffort(level, provider),
  );
  return parsed.success ? parsed.data : null;
}

/** Available logical levels; missing metadata preserves the existing defaults. */
export function getSupportedThinkingLevels(
  provider: ProviderConfig,
): readonly ThinkingLevel[] {
  if (
    provider.reasoning === false ||
    (provider.protocol === "anthropic" &&
      provider.thinking_mode !== "adaptive" &&
      getMaxOutputTokens(provider) <
        MIN_THINKING_BUDGET_TOKENS + MIN_THINKING_ANSWER_TOKENS)
  ) {
    return ["off"];
  }
  return THINKING_LEVELS.filter((level) => {
    if (level === "off") {
      return true;
    }
    if (
      provider.protocol === "anthropic" &&
      provider.thinking_mode === "adaptive"
    ) {
      return toAnthropicThinkingEffort(level, provider) !== null;
    }
    const effort = toReasoningEffort(level, provider);
    if (effort === null || effort === "none") {
      return false;
    }
    // Do not advertise xhigh/max under the openai protocols unless the
    // provider explicitly maps them: they have no native effort there, and
    // the collapse-to-high fallback in toReasoningEffort means offering them
    // would misrepresent what the request actually carries.
    if (
      (provider.protocol === "openai" ||
        provider.protocol === "openai-compat") &&
      (level === "xhigh" || level === "max") &&
      provider.thinking_level_map?.[level] === undefined
    ) {
      return false;
    }
    return true;
  });
}

/** Lower unsupported requests to the nearest available level, never higher. */
export function clampThinkingLevel(
  provider: ProviderConfig,
  level: ThinkingLevel,
): ThinkingLevel {
  const supported = getSupportedThinkingLevels(provider);
  let effective: ThinkingLevel = "off";
  for (const candidate of THINKING_LEVELS) {
    if (supported.includes(candidate)) {
      effective = candidate;
    }
    if (candidate === level) {
      break;
    }
  }
  return effective;
}

export function withProviderDefaults(provider: ProviderConfig): ProviderConfig {
  return {
    ...provider,
    thinking: getThinkingLevel(provider),
    context_window: getContextWindow(provider),
    max_output_tokens: getMaxOutputTokens(provider),
  };
}

export function getContextWindow(provider: ProviderConfig): number {
  return Number.isSafeInteger(provider.context_window) &&
    (provider.context_window ?? 0) > 0
    ? (provider.context_window ?? DEFAULT_CONTEXT_WINDOW)
    : DEFAULT_CONTEXT_WINDOW;
}

/**
 * Effective output cap for a provider. Configured value wins, otherwise the
 * 128k fallback applies; the result never exceeds the context window (PI's
 * `clampMaxTokensToContext`). This keeps small-output models from being sent an
 * over-large `max_tokens` while still letting users lower the cap.
 */
export function getMaxOutputTokens(provider: ProviderConfig): number {
  const configured = provider.max_output_tokens;
  const maxOutput =
    Number.isSafeInteger(configured) && (configured ?? 0) > 0
      ? (configured ?? DEFAULT_MAX_OUTPUT_TOKENS)
      : DEFAULT_MAX_OUTPUT_TOKENS;
  return Math.min(maxOutput, getContextWindow(provider));
}
