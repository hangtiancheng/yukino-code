import { WARMING_MAX_OUTPUT_TOKENS } from "@/cache/constants.js";
import { createCacheIdentity } from "@/cache/identity.js";
import { resolveCachePolicy } from "@/cache/policy.js";
import type { ProviderConfig } from "@/config/provider-config.js";
import type { LLMStreamOptions } from "@/llm/client.js";
import type { ProviderToolSchema } from "@/tools/types.js";

export function prepareCacheOptions(
  provider: ProviderConfig,
  system: string,
  tools: ProviderToolSchema[],
  options?: LLMStreamOptions,
): LLMStreamOptions {
  const policy = resolveCachePolicy(provider, options?.cacheMode);
  const identity = options?.cacheScope
    ? createCacheIdentity({
        provider: provider.name,
        endpoint: provider.base_url,
        model: provider.model,
        system,
        tools,
        ...options.cacheScope,
      })
    : options?.cacheIdentity;
  return {
    ...options,
    ...(options?.warming
      ? { maxOutputTokens: WARMING_MAX_OUTPUT_TOKENS, maxRetries: 0 }
      : {}),
    cacheMode: identity ? policy.mode : "off",
    cacheIdentity: identity,
    cacheTTLSeconds: identity ? policy.ttlSeconds : undefined,
  };
}
