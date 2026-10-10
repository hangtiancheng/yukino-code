import { createHash } from "node:crypto";

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

export function vectorToBlob(values: number[] | Float32Array): Uint8Array {
  const floats =
    values instanceof Float32Array ? values : Float32Array.from(values);
  return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
}

export function blobToVector(blob: Uint8Array, dim: number): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, dim);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
