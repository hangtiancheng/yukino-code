import { createHash } from "node:crypto";

// float[] -> Float32 little-endian Buffer (Redis VECTOR FLOAT32 wire format).
// Float32Array.buffer assumes a little-endian host, which covers all common
// platforms (x86, x86_64, ARM64).
export function float32ToBuffer(floats: number[]): Buffer {
  return Buffer.from(new Float32Array(floats).buffer);
}

// Redis TAG query syntax treats `-`, `.`, spaces and most punctuation as
// special; escape everything except letters, numbers and underscore so
// sources like "guides/upload-test.v2.md" don't break the query.
export function escapeTagValue(value: string): string {
  return value.replace(/[^\p{L}\p{N}_]/gu, "\\$&");
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
