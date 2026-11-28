import type PQueue from "p-queue";

export function acquireQueueSlot(
  queue: PQueue,
  signal?: AbortSignal,
): Promise<() => void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const waiting = new AbortController();
    const abort = () => {
      waiting.abort(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    void queue
      .add(
        () => {
          // Cancellation only removes waiting acquisitions; the owner releases a running task's slot.
          signal?.removeEventListener("abort", abort);
          return new Promise<void>((release) => {
            resolve(release);
          });
        },
        { signal: waiting.signal },
      )
      .catch((error: unknown) => {
        signal?.removeEventListener("abort", abort);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
}
