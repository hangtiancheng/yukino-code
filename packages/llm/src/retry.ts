import {
  BACKOFF_BASE_DELAY_MS,
  MAX_DELAY_MS,
  MAX_RETRIES,
  RATE_LIMIT_BASE_DELAY_MS,
} from "./constants.js";
import { NetworkError, RateLimitError, ServerError } from "./errors.js";

function retryAfterDelay(header: string | undefined, fallback: number): number {
  const value = header?.trim();
  if (!value) {
    return fallback;
  }
  if (/^\d+(?:\.\d+)?$/u.test(value)) {
    return Math.min(Number(value) * 1000, MAX_DELAY_MS);
  }
  const date = /^[A-Za-z]{3},/u.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(date)
    ? Math.min(Math.max(0, date - Date.now()), MAX_DELAY_MS)
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

export function waitForLlmRetry(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  const aborted = () => {
    const reason: unknown = signal?.reason;
    return reason instanceof Error
      ? reason
      : new DOMException("Retry interrupted", "AbortError");
  };
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(aborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
