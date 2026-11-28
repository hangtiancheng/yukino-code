import { setTimeout as delay } from "node:timers/promises";

import {
  BACKOFF_BASE_DELAY_MS,
  MAX_DELAY_MS,
  MAX_RETRIES,
  RATE_LIMIT_BASE_DELAY_MS,
} from "@/llm/constants.js";
import { NetworkError, RateLimitError, ServerError } from "@/llm/errors.js";

export function retryAfterDelay(
  header: string | undefined,
  fallback: number,
  maxDelay = MAX_DELAY_MS,
): number {
  const value = header?.trim();
  if (!value) {
    return fallback;
  }
  if (/^\d+(?:\.\d+)?$/u.test(value)) {
    return Math.min(Number(value) * 1000, maxDelay);
  }
  const date = /^[A-Za-z]{3},/u.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(date)
    ? Math.min(Math.max(0, date - Date.now()), maxDelay)
    : fallback;
}

export function llmRetryDelay(
  error: unknown,
  attempt: number,
): number | undefined {
  if (attempt >= MAX_RETRIES) {
    return undefined;
  }
  if (error instanceof RateLimitError) {
    return retryAfterDelay(
      error.retryAfter,
      RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt,
    );
  }
  const delay = Math.min(BACKOFF_BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  if (error instanceof ServerError) {
    return retryAfterDelay(error.retryAfter, delay);
  }
  return error instanceof NetworkError ? delay : undefined;
}

export async function waitForLlmRetry(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await delay(milliseconds, undefined, { signal });
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("Retry interrupted", "AbortError");
    }
    throw error;
  }
}
