import { addAbortListener } from "node:events";

export async function cancelOnSignal<T>(
  work: () => PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) {
    return work();
  }
  const { promise, reject } = Promise.withResolvers<never>();
  const listener = addAbortListener(signal, () => {
    reject(signal.reason);
  });
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        resolve(work());
      }),
    ]);
  } finally {
    listener[Symbol.dispose]();
  }
}
