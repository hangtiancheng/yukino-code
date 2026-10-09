import { createHash } from "node:crypto";

/**
 * L2-normalize an embedding so that cosine similarity reduces to a plain dot
 * product at query time. A zero-norm vector is returned unchanged: it then
 * scores 0 against everything instead of turning into NaN.
 */
export function normalizeVector(values: number[] | Float32Array): Float32Array {
  const out = Float32Array.from(values);
  let sum = 0;
  for (let i = 0; i < out.length; i++) {
    sum += out[i] * out[i];
  }
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let i = 0; i < out.length; i++) {
      out[i] /= norm;
    }
  }
  return out;
}

/**
 * Float32 little-endian bytes as stored in the `chunks.vector` BLOB column.
 * Float32Array.byteLength already assumes a little-endian host, which covers
 * every platform this CLI ships prebuilt for (x86_64, ARM64).
 */
export function vectorToBlob(values: number[] | Float32Array): Uint8Array {
  const floats =
    values instanceof Float32Array ? values : Float32Array.from(values);
  return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
}

/** Read a `chunks.vector` BLOB back as floats. */
export function blobToVector(blob: Uint8Array, dim: number): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, dim);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
