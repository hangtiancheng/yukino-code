import type { z } from "zod";

import {
  ProviderPriceSchema,
  type ProviderConfig,
} from "@/config/provider-config.js";
import { TOKENS_PER_PRICE_UNIT } from "@/cost/constants.js";
import type { Money, UsageSnapshot } from "@/cost/types.js";

export type PriceSnapshot = z.infer<typeof ProviderPriceSchema>;

export function snapshotPrice(
  provider: ProviderConfig,
  now: number,
): PriceSnapshot | null {
  const parsed = ProviderPriceSchema.safeParse(provider.price);
  const price = parsed.success ? parsed.data : null;
  if (
    !price ||
    now < Date.parse(price.effective_at) ||
    (price.effective_until && now >= Date.parse(price.effective_until))
  ) {
    return null;
  }
  return structuredClone(price);
}

export function estimateUsage(
  usage: UsageSnapshot | null,
  price: PriceSnapshot | null,
  cacheTTLSeconds?: number,
): Money {
  const currency = price?.currency ?? null;
  if (!usage || !price || !currency) {
    return { currency, amount: null };
  }
  const counts = [
    usage.inputTokens,
    usage.cacheReadInputTokens,
    usage.cacheCreationInputTokens,
  ];
  if (counts.some((count) => count === undefined)) {
    return { currency, amount: null };
  }
  const contextTokens = counts.reduce<number>(
    (sum, count) => sum + (count ?? 0),
    0,
  );
  const tier = price.tiers
    ?.filter((candidate) => contextTokens > candidate.above_input_tokens)
    .sort((a, b) => b.above_input_tokens - a.above_input_tokens)[0];
  const rates = { ...price, ...tier };
  let total = 0;
  const categories: [number | undefined, number | null | undefined][] = [
    [usage.inputTokens, rates.input],
    [usage.outputTokens, rates.output],
    [usage.cacheReadInputTokens, rates.cache_read],
  ];
  for (const [tokens, rate] of categories) {
    if (tokens === undefined || (tokens > 0 && rate == null)) {
      return { currency, amount: null };
    }
    total += tokens * (rate ?? 0);
  }
  const writes = usage.cacheCreationInputTokens ?? 0;
  if (writes > 0) {
    const byTTL =
      usage.cacheCreationByTTL ??
      (cacheTTLSeconds ? { [String(cacheTTLSeconds)]: writes } : null);
    if (rates.cache_creation_ttl?.length) {
      if (
        !byTTL ||
        Object.values(byTTL).reduce((a, b) => a + b, 0) !== writes
      ) {
        return { currency, amount: null };
      }
      for (const [ttl, tokens] of Object.entries(byTTL)) {
        const rate = rates.cache_creation_ttl.find(
          (item) => item.ttl_seconds === Number(ttl),
        )?.rate;
        if (tokens > 0 && rate == null) {
          return { currency, amount: null };
        }
        total += tokens * (rate ?? 0);
      }
    } else {
      if (rates.cache_write == null) {
        return { currency, amount: null };
      }
      total += writes * rates.cache_write;
    }
  }
  return { currency, amount: total / TOKENS_PER_PRICE_UNIT };
}
