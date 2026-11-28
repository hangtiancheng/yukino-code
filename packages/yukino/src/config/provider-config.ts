/**
 * Leaf module for the provider-config domain: the global config path, the
 * provider schema, and the thinking-level machinery. It must not import the
 * config barrel (./index.js) or provider-login, so both of those can depend
 * on it without creating an evaluation cycle — provider-login builds its zod
 * schema from these values at module scope, which previously TDZ-crashed the
 * nested `Config.ProviderLogin` re-export.
 */

import { z } from "zod";

import {
  DEFAULT_WARMING_FREQUENCY_MS,
  DEFAULT_WARMING_MAX_IDLE_MS,
} from "@/cache/constants.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_THINKING_LEVEL,
  GLOBAL_CONFIG_FILENAME,
  MIN_THINKING_ANSWER_TOKENS,
  MIN_THINKING_BUDGET_TOKENS,
  THINKING_BUDGETS,
  THINKING_LEVELS,
} from "@/config/constants.js";
import { yukinoPath } from "@/storage/index.js";

export function globalConfigPath(): string {
  return yukinoPath(GLOBAL_CONFIG_FILENAME);
}

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

const TokenRatesSchema = z.strictObject({
  input: z.number().nonnegative().nullable().optional(),
  output: z.number().nonnegative().nullable().optional(),
  cache_read: z.number().nonnegative().nullable().optional(),
  cache_write: z.number().nonnegative().nullable().optional(),
  cache_creation_ttl: z
    .array(
      z.strictObject({
        ttl_seconds: z.number().int().positive(),
        rate: z.number().nonnegative().nullable(),
      }),
    )
    .optional(),
});

/** Rates are currency units per million tokens; tiers price the whole request. */
export const ProviderPriceSchema = z
  .strictObject({
    ...TokenRatesSchema.shape,
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    source: z.string().min(1),
    effective_at: z.iso.datetime(),
    effective_until: z.iso.datetime().optional(),
    tiers: z
      .array(
        z.strictObject({
          above_input_tokens: z.number().int().nonnegative(),
          ...TokenRatesSchema.shape,
        }),
      )
      .optional(),
  })
  .superRefine((price, ctx) => {
    const thresholds =
      price.tiers?.map((tier) => tier.above_input_tokens) ?? [];
    if (new Set(thresholds).size !== thresholds.length) {
      ctx.addIssue({
        code: "custom",
        message: "Duplicate price tier threshold",
      });
    }
    if (price.effective_until && price.effective_until <= price.effective_at) {
      ctx.addIssue({
        code: "custom",
        message: "Invalid price effective interval",
      });
    }
  });

const CacheWindowSchema = z.strictObject({
  ttl_seconds: z.number().int().positive(),
  min_tokens: z.number().int().nonnegative(),
});

export const ProviderCacheSchema = z.strictObject({
  mode: z.enum(["off", "short", "long"]).default("off"),
  capabilities: z
    .strictObject({
      verified: z.literal(true),
      mapping: z.enum(["anthropic_ephemeral", "openai_retention"]),
      short: CacheWindowSchema.optional(),
      long: CacheWindowSchema.optional(),
      replayable: z.boolean().default(false),
    })
    .optional(),
});

export const ProviderWarmingSchema = z.strictObject({
  mode: z.enum(["off", "streaming", "idle"]).default("off"),
  reuse_probability: z.number().min(0).max(1).default(0),
  net_benefit_threshold: z.number().nonnegative().default(0),
  frequency_ms: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_WARMING_FREQUENCY_MS),
  max_idle_ms: z.number().int().positive().default(DEFAULT_WARMING_MAX_IDLE_MS),
});

export const SamplingParamsSchema = z.record(z.string(), z.json());
export type SamplingParams = z.infer<typeof SamplingParamsSchema>;
const SamplingParamsByThinkingLevelSchema = z.partialRecord(
  z.enum(THINKING_LEVELS),
  SamplingParamsSchema,
);

export const ProviderConfigSchema = z.looseObject({
  name: z.string(),
  protocol: z.enum(["anthropic", "openai", "openai-compat"]),
  base_url: z.string(),
  model: z.string(),
  api_key: z.string().optional(),
  thinking: z.enum(THINKING_LEVELS).optional(),
  sampling_params: SamplingParamsSchema.optional(),
  sampling_params_by_thinking_level:
    SamplingParamsByThinkingLevelSchema.optional(),
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
  price: ProviderPriceSchema.optional(),
  cache: ProviderCacheSchema.optional(),
  warming: ProviderWarmingSchema.optional(),
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

export function thinkingBudgetForProvider(
  provider: ProviderConfig,
  level: ThinkingLevel,
): number {
  const effort = toReasoningEffort(level, provider);
  return effort === null || effort === "none"
    ? 0
    : thinkingBudgetForLevel(effort);
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
    return effort !== null && effort !== "none";
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

export function resolveSamplingParams(
  provider: ProviderConfig,
  level: ThinkingLevel,
  request?: SamplingParams,
): SamplingParams {
  return {
    ...provider.sampling_params,
    ...provider.sampling_params_by_thinking_level?.[
      clampThinkingLevel(provider, level)
    ],
    ...(request ? SamplingParamsSchema.parse(request) : {}),
  };
}
