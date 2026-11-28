import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

import {
  IMAGE_FILE_EMPTY_ERROR,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_BYTES_PASSTHROUGH,
  MAX_IMAGE_INPUT_BYTES,
  MEDIA_TYPE_BY_EXTENSION,
} from "@/images/constants.js";
import { sniffMediaType } from "@/images/media-type.js";
import type { ImageMediaType, ScreenshotOptions } from "@/images/types.js";
import { processImage } from "@/images/worker.js";
import { createChildLogger } from "@/logger/index.js";

export * from "@/images/media-type.js";
export * from "@/images/clipboard.js";
export * from "@/images/constants.js";
export * from "@/images/types.js";
export * from "@/images/worker.js";

const log = createChildLogger({ module: "images" });

interface ImageAttachment {
  mediaType: ImageMediaType;
  /** Raw base64 payload without a data: URL prefix. */
  data: string;
  /** Absolute path of the source image file. */
  sourcePath?: string | undefined;
  /** Decoded byte length of `data`. */
  byteLength: number;
}

export class ImageTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageTooLargeError";
  }
}

export function getMediaType(path: string): ImageMediaType | null {
  return MEDIA_TYPE_BY_EXTENSION[extname(path).toLowerCase()] ?? null;
}

export function isImagePath(path: string): boolean {
  return getMediaType(path) !== null;
}

// Read an image file, validate its real format via magic bytes, and compress
// it to fit API limits. Throws with context on any failure (caller decides
// how to degrade).
export async function loadImageAttachment(
  absPath: string,
  signal?: AbortSignal,
): Promise<ImageAttachment> {
  signal?.throwIfAborted();
  const st = await stat(absPath);
  if (!st.isFile()) {
    throw new Error(`Not a file: ${absPath}`);
  }
  if (st.size > MAX_IMAGE_INPUT_BYTES) {
    throw new ImageTooLargeError(
      `Image file is ${formatMB(st.size)} on disk; files over ${formatMB(MAX_IMAGE_INPUT_BYTES)} are not read. Please provide a smaller image.`,
    );
  }
  const buf = await readFile(absPath, { signal });

  const sniffed = await sniffMediaType(buf);
  if (!sniffed) {
    throw new Error(
      `File ${absPath} has an image extension but its contents are not a supported image format (png/jpeg/gif/webp)`,
    );
  }
  // Magic bytes win over the extension when they disagree.
  const resized = await maybeResizeAndDownsampleImage(buf, sniffed, signal);
  signal?.throwIfAborted();
  return {
    mediaType: resized.mediaType,
    data: resized.data,
    sourcePath: absPath,
    byteLength: resized.byteLength,
  };
}

type ResizedImage = Omit<ImageAttachment, "sourcePath">;

function toResult(buf: Buffer, mediaType: ImageMediaType): ResizedImage {
  return { data: buf.toString("base64"), mediaType, byteLength: buf.length };
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export async function maybeResizeAndDownsampleImage(
  buf: Buffer,
  mediaType: ImageMediaType,
  signal?: AbortSignal,
): Promise<ResizedImage> {
  signal?.throwIfAborted();
  if (buf.length === 0) {
    throw new ImageTooLargeError(IMAGE_FILE_EMPTY_ERROR);
  }
  if (buf.length <= MAX_IMAGE_BYTES_PASSTHROUGH) {
    return toResult(buf, mediaType);
  }

  try {
    return await processImage({ bytes: buf }, signal);
  } catch (err) {
    signal?.throwIfAborted();
    log.warn({ err }, "image compression failed");
    throw new ImageTooLargeError(
      `Image is ${formatMB(buf.length)} raw (${formatMB((buf.length * 4) / 3)} base64-encoded, API limit ${formatMB(MAX_IMAGE_BYTES)}) and compression failed. Please provide a smaller image.`,
    );
  }
}

export function processScreenshot(
  bytes: Buffer,
  options: ScreenshotOptions,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  return processImage({ bytes, screenshot: options }, signal);
}
