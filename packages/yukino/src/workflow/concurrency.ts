import {
  DEFAULT_MAX_CONCURRENCY,
  MAX_CONCURRENCY_CAP,
} from "@/workflow/constants.js";

export class Semaphore {
  private available: number;
  private readonly waiters: {
    wake: () => void;
  }[] = [];

  constructor(permits: number) {
    this.available = Math.max(1, Math.floor(permits));
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new Error("Semaphore.acquire aborted (signal already aborted)");
    }
    if (this.available > 0) {
      this.available -= 1;
      return () => {
        this.release();
      };
    }
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = () => {
        const idx = this.waiters.indexOf(entry);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
        }
        reject(new Error("Semaphore.acquire aborted"));
      };
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve(() => {
          this.release();
        });
      };
      const entry = {
        wake,
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(entry);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next.wake(); // transfer the permit directly
    } else {
      this.available += 1;
    }
  }
}

export function clampMaxConcurrency(n: number | undefined): number {
  if (n === undefined || Number.isNaN(n)) {
    return DEFAULT_MAX_CONCURRENCY;
  }
  return Math.max(1, Math.min(Math.trunc(n), MAX_CONCURRENCY_CAP));
}
