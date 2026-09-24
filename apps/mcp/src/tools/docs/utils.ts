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
