import {
  DEFAULT_MAX_CONCURRENCY,
  MAX_CONCURRENCY_CAP,
} from "@/workflow/constants.js";

export function clampMaxConcurrency(n: number | undefined): number {
  if (n === undefined || Number.isNaN(n)) {
    return DEFAULT_MAX_CONCURRENCY;
  }
  return Math.max(1, Math.min(Math.trunc(n), MAX_CONCURRENCY_CAP));
}
