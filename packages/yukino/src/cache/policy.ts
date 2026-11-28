import {
  ProviderConfigSchema,
  type ProviderConfig,
} from "@/config/provider-config.js";

export interface CachePolicy {
  mode: "off" | "short" | "long";
  reason?: string;
  ttlSeconds?: number;
  minTokens?: number;
  mapping?: "anthropic_ephemeral" | "openai_retention";
  bestEffort: true;
}

export function resolveCachePolicy(
  provider: ProviderConfig,
  requested = provider.cache?.mode ?? "off",
): CachePolicy {
  if (requested === "off") {
    return { mode: "off", bestEffort: true, reason: "disabled" };
  }
  const parsed = ProviderConfigSchema.safeParse(provider);
  const capability = parsed.success
    ? parsed.data.cache?.capabilities
    : undefined;
  const window = capability?.[requested];
  const protocolMatches =
    provider.protocol === "anthropic"
      ? capability?.mapping === "anthropic_ephemeral"
      : capability?.mapping === "openai_retention";
  const ttlMatches =
    capability?.mapping === "anthropic_ephemeral"
      ? window?.ttl_seconds === (requested === "short" ? 300 : 3600)
      : requested !== "long" || window?.ttl_seconds === 86400;
  if (!capability || !window || !protocolMatches || !ttlMatches) {
    return {
      mode: "off",
      bestEffort: true,
      reason: "unverified_or_unsupported",
    };
  }
  return {
    mode: requested,
    ttlSeconds: window.ttl_seconds,
    minTokens: window.min_tokens,
    mapping: capability.mapping,
    bestEffort: true,
  };
}

export function openAICacheParams(
  policy: CachePolicy,
  identity?: string,
): {
  prompt_cache_key?: string;
  prompt_cache_retention?: "in_memory" | "24h";
} {
  if (
    policy.mode === "off" ||
    policy.mapping !== "openai_retention" ||
    !identity
  ) {
    return {};
  }
  return {
    prompt_cache_key: identity,
    prompt_cache_retention: policy.mode === "long" ? "24h" : "in_memory",
  };
}
