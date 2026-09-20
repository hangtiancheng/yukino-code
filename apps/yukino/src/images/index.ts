/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

import sharp from "sharp";

import { createChildLogger } from "@/logger/index.js";

// Submodule namespaces for library consumers (Images.<Sub>.*).
export * as Clipboard from "./clipboard.js";

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
  /** Original file path, used for UI labels and session provenance. */
  sourcePath?: string | undefined;
  /** Decoded byte length of `data`. */
  byteLength: number;
}

// Hard limit is 5MB on the base64-encoded payload. base64 inflates by 4/3, so the raw-byte target that always fits is 5MB * 3/4 = 3.75MB.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_BYTES_PASSTHROUGH = (MAX_IMAGE_BYTES * 3) / 4;

export const MAX_DIMENSION_PX = 2000;

// Cap images per user message to stay well under provider block limits.
export const MAX_IMAGES_PER_MESSAGE = 10;

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
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
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

// Read an image file, validate its real format via magic bytes, and compress
// it to fit API limits. Throws with context on any failure (caller decides
// how to degrade).
export async function loadImageAttachment(absPath: string): Promise<ImageAttachment> {
  const st = statSync(absPath);
  if (!st.isFile()) {
    throw new Error(`Not a file: ${absPath}`);
  }
  const buf = readFileSync(absPath);

  const sniffed = sniffMediaType(buf);
  if (!sniffed) {
    throw new Error(
      `File ${absPath} has an image extension but its contents are not a supported image format (png/jpeg/gif/webp)`,
    );
  }
  // Magic bytes win over the extension when they disagree.
  const resized = await maybeResizeAndDownsampleImage(buf, sniffed);
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
//   1. <=3.75MB raw passes through untouched (sharp never invoked).
//   2. Otherwise: cap dimensions at 2000px, keep PNG when possible
//      (compressionLevel 8), then walk the JPEG quality ladder 80/60/40/20,
//      then halve dimensions and retry (max twice).
// GIF/WebP are re-encoded to PNG/JPEG only when they need compression, which
// also normalizes animated GIFs to their first frame.
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
    return await compressWithSharp(buf, mediaType);
  } catch (err) {
    if (err instanceof ImageTooLargeError) {
      throw err;
    }
    // sharp failed at runtime (corrupt file, unsupported variant, ...).
    // We only get here when the raw size already exceeds the passthrough
    // target (3.75MB), so its base64 form necessarily exceeds the 5MB API
    // limit — there is no valid passthrough, fail with context.
    log.warn({ err }, "sharp compression failed");
    throw new ImageTooLargeError(
      `Image is ${formatMB(buf.length)} raw (${formatMB((buf.length * 4) / 3)} base64-encoded, API limit ${formatMB(MAX_IMAGE_BYTES)}) and compression failed. Please provide a smaller image.`,
    );
  }
}

async function compressWithSharp(buf: Buffer, mediaType: ImageMediaType): Promise<ResizedImage> {
  const metadata = await sharp(buf).metadata();
  let width = metadata.width ?? MAX_DIMENSION_PX;
  let height = metadata.height ?? MAX_DIMENSION_PX;

  if (width > MAX_DIMENSION_PX) {
    height = Math.max(1, Math.round((height * MAX_DIMENSION_PX) / width));
    width = MAX_DIMENSION_PX;
  }
  if (height > MAX_DIMENSION_PX) {
    width = Math.max(1, Math.round((width * MAX_DIMENSION_PX) / height));
    height = MAX_DIMENSION_PX;
  }

  const preservePng = mediaType === "image/png" || mediaType === "image/gif";

  // Halve dimensions and retry the whole ladder at most twice.
  for (let attempt = 0; attempt < 3; attempt++) {
    // IMPORTANT: create a fresh sharp(buf) per operation — reusing an
    // instance after toBuffer() does not re-apply format conversions.
    if (preservePng) {
      const png = await sharp(buf)
        .resize(width, height, { fit: "inside", withoutEnlargement: true })
        .png({ compressionLevel: 8, palette: true })
        .toBuffer();
      if (png.length <= MAX_IMAGE_BYTES_PASSTHROUGH) {
        return toResult(png, "image/png");
      }
    }
    for (const quality of [80, 60, 40, 20] /** jpeg quality */) {
      const jpeg = await sharp(buf)
        .resize(width, height, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
      if (jpeg.length <= MAX_IMAGE_BYTES_PASSTHROUGH) {
        return toResult(jpeg, "image/jpeg");
      }
    }
    width = Math.max(1, Math.round(width / 2));
    height = Math.max(1, Math.round(height / 2));
  }

  throw new ImageTooLargeError(
    `Unable to compress image (${formatMB(buf.length)} raw) under the ${formatMB(MAX_IMAGE_BYTES)} API limit. Please provide a smaller image.`,
  );
}
