import PQueue from "p-queue";

import { acquireQueueSlot } from "@/utils/concurrency.js";
import { canonicalPath } from "@/utils/paths.js";

const admission = new PQueue({ concurrency: 1 });
const queues = new Map<string, PQueue>();

export function withFileMutationQueue<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withFileMutationQueues([filePath], operation);
}

export async function withFileMutationQueues<T>(
  filePaths: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const { slots, entries } = await admission.add(() => {
    const keys = [
      ...new Set(filePaths.map((path) => canonicalPath(path))),
    ].sort();
    const entries = keys.map((key) => {
      const queue = queues.get(key) ?? new PQueue({ concurrency: 1 });
      queues.set(key, queue);
      return { key, queue };
    });
    return {
      entries,
      slots: Promise.all(entries.map(({ queue }) => acquireQueueSlot(queue))),
    };
  });
  const releases = await slots;
  try {
    return await operation();
  } finally {
    for (const release of releases) {
      release();
    }
    for (const { key, queue } of entries) {
      void queue.onIdle().then(() => {
        if (queues.get(key) === queue && !queue.size && !queue.pending) {
          queues.delete(key);
        }
      });
    }
  }
}
