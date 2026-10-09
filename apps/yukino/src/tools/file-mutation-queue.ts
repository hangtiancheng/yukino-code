import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const queues = new Map<string, Promise<void>>();
// Chain of queue joins: taking a place in this chain synchronously (before
// any await) is what preserves FIFO for concurrent callers.
let joinChain: Promise<void> = Promise.resolve();

async function canonicalPath(filePath: string): Promise<string> {
  const absolutePath = resolve(filePath);
  try {
    return await realpath(absolutePath);
  } catch {
    try {
      return join(
        await realpath(dirname(absolutePath)),
        basename(absolutePath),
      );
    } catch {
      return absolutePath;
    }
  }
}

interface QueueSlot {
  key: string;
  previous: Promise<void>;
  queued: Promise<void>;
  release: () => void;
}

/**
 * Serialize mutations targeting the same resolved path.
 *
 * Call order is preserved: every caller synchronously takes a place in the
 * join chain before awaiting anything, and only then resolves its path and
 * appends to the per-key chain. Same-key callers therefore run FIFO, while
 * different keys still proceed concurrently.
 */
export async function withFileMutationQueue<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const myJoin = joinChain.then(async (): Promise<QueueSlot> => {
    const key = await canonicalPath(filePath);
    const previous = queues.get(key) ?? Promise.resolve();
    let release: () => void = () => {
      /** noop */
    };
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => next);
    queues.set(key, queued);
    return { key, previous, queued, release };
  });
  joinChain = myJoin.then(
    () => undefined,
    () => undefined,
  );
  const slot = await myJoin;

  try {
    return await slot.previous.then(operation);
  } finally {
    slot.release();
    if (queues.get(slot.key) === slot.queued) {
      queues.delete(slot.key);
    }
  }
}
