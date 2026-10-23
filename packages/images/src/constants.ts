import type { ImageMediaType } from "./types.js";

// Hard limit is 5MB on the base64-encoded payload. base64 inflates by 4/3, so the raw-byte target that always fits is 5MB * 3/4 = 3.75MB.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_BYTES_PASSTHROUGH = (MAX_IMAGE_BYTES * 3) / 4;
// On-disk admission cap for loadImageAttachment (pre-read memory bound).
export const MAX_IMAGE_INPUT_BYTES = 50 * 1024 * 1024;

export const MAX_DIMENSION_PX = 2000;

export const IMAGE_WORKER_TIMEOUT_MS = 120_000;
export const IMAGE_WORKER_TIMEOUT_ERROR = "Image processing timed out.";
export const IMAGE_WORKER_EXIT_ERROR =
  "Image processing worker exited without a result.";
export const IMAGE_PROCESSING_ABORTED_ERROR = "Image processing was aborted.";
export const IMAGE_FILE_EMPTY_ERROR = "Image file is empty (0 bytes)";

// Cap images per user message to stay well under provider block limits.
export const MAX_IMAGES_PER_MESSAGE = 10;

export const CLIPBOARD_TIMEOUT_MS = 5_000;
export const MAX_CLIPBOARD_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_STDERR_BYTES = 16 * 1024;
export const NO_IMAGE_MESSAGE = "The clipboard does not contain an image.";
export const CLIPBOARD_NOT_PNG_ERROR = "Clipboard data is not a PNG image.";
export const CLIPBOARD_NO_SESSION_ERROR =
  "No Wayland or X11 session found (WAYLAND_DISPLAY and DISPLAY are unset).";

export const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export const MEDIA_TYPE_BY_EXTENSION: Record<string, ImageMediaType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
