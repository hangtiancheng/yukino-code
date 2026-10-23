import { Worker } from "node:worker_threads";

import {
  IMAGE_PROCESSING_ABORTED_ERROR,
  IMAGE_WORKER_EXIT_ERROR,
  IMAGE_WORKER_TIMEOUT_ERROR,
  IMAGE_WORKER_TIMEOUT_MS,
  MAX_DIMENSION_PX,
  MAX_IMAGE_BYTES_PASSTHROUGH,
} from "./constants.js";
import { ImageWorkerResponseSchema } from "./types.js";
import type {
  ImageProcessingRequest,
  ImageWorkerData,
  ProcessedImage,
} from "./types.js";

let pending: Promise<unknown> = Promise.resolve();

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new Error(IMAGE_PROCESSING_ABORTED_ERROR);
}

export function processImage(
  request: ImageProcessingRequest,
  signal?: AbortSignal,
): Promise<ProcessedImage> {
  const result = pending.then(async () => {
    signal?.throwIfAborted();
    const bytes = Uint8Array.from(request.bytes);
    const workerData: ImageWorkerData = {
      request: { ...request, bytes },
      maxDimension: MAX_DIMENSION_PX,
      maxBytes: MAX_IMAGE_BYTES_PASSTHROUGH,
    };
    const worker = new Worker(new URL("./image-worker.js", import.meta.url), {
      workerData,
      transferList: [bytes.buffer],
      execArgv: [],
    });

    try {
      return await new Promise<ProcessedImage>((resolve, reject) => {
        const finish = (error?: Error, image?: ProcessedImage): void => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          worker.removeAllListeners();
          if (image) {
            resolve(image);
          } else {
            reject(error ?? new Error(IMAGE_WORKER_EXIT_ERROR));
          }
        };
        const onAbort = (): void => {
          const reason: unknown = signal?.reason;
          finish(
            reason instanceof Error
              ? reason
              : new Error(IMAGE_PROCESSING_ABORTED_ERROR),
          );
        };
        const timer = setTimeout(() => {
          finish(new Error(IMAGE_WORKER_TIMEOUT_ERROR));
        }, IMAGE_WORKER_TIMEOUT_MS);
        worker.once("message", (message: unknown) => {
          const response = ImageWorkerResponseSchema.safeParse(message);
          if (!response.success) {
            finish(response.error);
          } else if ("error" in response.data) {
            finish(new Error(response.data.error));
          } else {
            finish(undefined, response.data.image);
          }
        });
        worker.once("error", finish);
        worker.once("exit", () => {
          finish(new Error(IMAGE_WORKER_EXIT_ERROR));
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
        }
      });
    } finally {
      await worker.terminate();
    }
  });
  pending = result.catch(() => undefined);
  if (!signal) {
    return result;
  }
  return new Promise<ProcessedImage>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void result
      .finally(() => {
        signal.removeEventListener("abort", onAbort);
      })
      .then(resolve, reject);
    if (signal.aborted) {
      onAbort();
    }
  });
}
