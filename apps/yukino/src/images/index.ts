import { open, readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

import {
  IMAGE_FILE_EMPTY_ERROR,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_BYTES_PASSTHROUGH,
  MAX_IMAGE_INPUT_BYTES,
  MEDIA_TYPE_BY_EXTENSION,
} from "@/images/constants.js";
import type { ImageMediaType, ScreenshotOptions } from "@/images/types.js";
import { processImage } from "@/images/worker.js";
import { createChildLogger } from "@/logger/index.js";

// Submodule namespaces for library consumers (Images.<Sub>.*).
export * as Clipboard from "@/images/clipboard.js";
export * as Constants from "@/images/constants.js";

const log = createChildLogger({ module: "images" });

export function asImageMediaType(type: string): ImageMediaType {
  if (
    type === "image/png" ||
    type === "image/jpeg" ||
    type === "image/gif" ||
    type === "image/webp"
  ) {
    return type;
  }
  throw new Error(`Unsupported image media type: "${type}"`);
}

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

// Detect the real format from magic bytes. Returns null when the buffer is
// not a recognized image — callers should reject rather than trust the
// file extension.
export function sniffMediaType(buf: Buffer): ImageMediaType | null {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    buf.length >= 3 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46
  ) {
    return "image/gif";
  }
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export async function sniffFileMediaType(
  absPath: string,
  signal?: AbortSignal,
): Promise<ImageMediaType | null> {
  signal?.throwIfAborted();
  const file = await open(absPath, "r");
  try {
    signal?.throwIfAborted();
    const header = Buffer.alloc(12);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    signal?.throwIfAborted();
    return sniffMediaType(header.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
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

  const sniffed = sniffMediaType(buf);
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
