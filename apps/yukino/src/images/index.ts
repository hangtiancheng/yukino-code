import { open, readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

import { Jimp } from "jimp";

import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_BYTES_PASSTHROUGH,
  MAX_IMAGE_INPUT_BYTES,
  MAX_DIMENSION_PX,
} from "@/images/constants.js";
import { createChildLogger } from "@/logger/index.js";

// Submodule namespaces for library consumers (Images.<Sub>.*).
export * as Clipboard from "@/images/clipboard.js";
export * as Constants from "@/images/constants.js";

const log = createChildLogger({ module: "images" });

type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

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

const mediaType: Record<string, ImageMediaType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function getMediaType(path: string): ImageMediaType | null {
  return mediaType[extname(path).toLowerCase()] ?? null;
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
  const resized = await maybeResizeAndDownsampleImage(buf, sniffed);
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

// Resize/compress an image buffer so its base64 encoding fits the API limit:
//   1. <=3.75MB raw passes through untouched (jimp never invoked).
//   2. Otherwise: cap dimensions at 2000px; PNG/GIF sources try PNG first
//      (deflateLevel 9), then every source walks the JPEG quality ladder
//      80/60/40/20; halve dimensions and retry the whole ladder at most twice.
// GIF sources are re-encoded only when they need compression, which normalizes
// animated GIFs to their first frame. jimp cannot decode WebP, so an oversized
// WebP fails with ImageTooLargeError (small WebP still passes through).
export async function maybeResizeAndDownsampleImage(
  buf: Buffer,
  mediaType: ImageMediaType,
): Promise<ResizedImage> {
  if (buf.length === 0) {
    throw new ImageTooLargeError("Image file is empty (0 bytes)");
  }
  if (buf.length <= MAX_IMAGE_BYTES_PASSTHROUGH) {
    return toResult(buf, mediaType);
  }

  try {
    return await compressWithJimp(buf);
  } catch (err) {
    if (err instanceof ImageTooLargeError) {
      throw err;
    }
    // jimp failed at runtime (corrupt file, undecodable WebP, ...).
    // We only get here when the raw size already exceeds the passthrough
    // target (3.75MB), so its base64 form necessarily exceeds the 5MB API
    // limit — there is no valid passthrough, fail with context.
    log.warn({ err }, "image compression failed");
    throw new ImageTooLargeError(
      `Image is ${formatMB(buf.length)} raw (${formatMB((buf.length * 4) / 3)} base64-encoded, API limit ${formatMB(MAX_IMAGE_BYTES)}) and compression failed. Please provide a smaller image.`,
    );
  }
}

async function compressWithJimp(buf: Buffer): Promise<ResizedImage> {
  const image = await Jimp.read(buf);
  let width = image.width;
  let height = image.height;

  if (width > MAX_DIMENSION_PX) {
    height = Math.max(1, Math.round((height * MAX_DIMENSION_PX) / width));
    width = MAX_DIMENSION_PX;
  }
  if (height > MAX_DIMENSION_PX) {
    width = Math.max(1, Math.round((width * MAX_DIMENSION_PX) / height));
    height = MAX_DIMENSION_PX;
  }

  const preservePng = image.mime === "image/png" || image.mime === "image/gif";

  // Halve dimensions and retry the whole ladder at most twice.
  for (let attempt = 0; attempt < 3; attempt++) {
    // Resize from a fresh clone each attempt so repeated halving always
    // resamples the original pixels, not a previously downsampled copy.
    // Skip the resample entirely when the target already matches the source.
    const resized = image.clone();
    if (width !== resized.width || height !== resized.height) {
      resized.resize({ w: width, h: height });
    }
    if (preservePng) {
      const png = await resized.getBuffer("image/png", { deflateLevel: 9 });
      if (png.length <= MAX_IMAGE_BYTES_PASSTHROUGH) {
        return toResult(png, "image/png");
      }
    }
    for (const quality of [80, 60, 40, 20]) {
      const jpeg = await resized.getBuffer("image/jpeg", { quality });
      if (jpeg.length <= MAX_IMAGE_BYTES_PASSTHROUGH) {
        return toResult(jpeg, "image/jpeg");
      }
    }
    width = Math.max(1, Math.round(width / 2));
    height = Math.max(1, Math.round(height / 2));
  }

  throw new ImageTooLargeError(
    `Unable to compress image (${formatMB(buf.length)} raw) under the ${formatMB(MAX_IMAGE_BYTES)} base64 API limit (raw bytes must be ≤${formatMB(MAX_IMAGE_BYTES_PASSTHROUGH)}). Please provide a smaller image.`,
  );
}
