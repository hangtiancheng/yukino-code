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

import { describe, expect, it } from "vitest";

import { escapeTagValue, float32ToBuffer, sha256 } from "@/tools/docs/utils.js";

describe("escapeTagValue", () => {
  it("escapes hyphens, dots and slashes in filenames", () => {
    expect(escapeTagValue("upload-test.v2.md")).toBe("upload\\-test\\.v2\\.md");
    expect(escapeTagValue("guides/setup.md")).toBe("guides\\/setup\\.md");
  });

  it("keeps letters, digits, underscore and CJK untouched", () => {
    expect(escapeTagValue("abc_123")).toBe("abc_123");
    expect(escapeTagValue("知识库")).toBe("知识库");
  });

  it("escapes spaces and punctuation", () => {
    expect(escapeTagValue("a b{c}")).toBe("a\\ b\\{c\\}");
  });
});

describe("float32ToBuffer", () => {
  it("produces 4 bytes per float, little-endian, round-trippable", () => {
    const values = [0.5, -1.25, 3];
    const buf = float32ToBuffer(values);
    expect(buf.length).toBe(values.length * 4);
    const back = Array.from(new Float32Array(buf.buffer, buf.byteOffset, values.length));
    expect(back).toEqual(values);
  });

  it("handles empty input", () => {
    expect(float32ToBuffer([]).length).toBe(0);
  });
});

describe("sha256", () => {
  it("returns stable 64-char hex", () => {
    const hash = sha256("hello");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256("hello")).toBe(hash);
    expect(sha256("hello!")).not.toBe(hash);
  });
});
