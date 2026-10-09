import { describe, expect, it } from "vitest";

import {
  blobToVector,
  normalizeVector,
  sha256,
  vectorToBlob,
} from "@/tools/docs/utils.js";

describe("normalizeVector", () => {
  it("scales to unit length so a dot product is the cosine similarity", () => {
    const unit = normalizeVector([3, 4]);
    expect(unit[0]).toBeCloseTo(0.6, 6);
    expect(unit[1]).toBeCloseTo(0.8, 6);
    expect(Math.hypot(...unit)).toBeCloseTo(1, 6);
  });

  it("leaves a zero vector alone instead of producing NaN", () => {
    expect(Array.from(normalizeVector([0, 0]))).toEqual([0, 0]);
  });

  it("does not mutate the input", () => {
    const input = [3, 4];
    normalizeVector(input);
    expect(input).toEqual([3, 4]);
  });
});

describe("vectorToBlob / blobToVector", () => {
  it("round-trips through the BLOB column layout", () => {
    const values = [0.5, -1.25, 3];
    const blob = vectorToBlob(values);
    expect(blob.byteLength).toBe(values.length * 4);
    expect(Array.from(blobToVector(blob, values.length))).toEqual(values);
  });

  it("accepts a Float32Array without copying", () => {
    const floats = new Float32Array([1, 2]);
    expect(vectorToBlob(floats).byteLength).toBe(8);
  });

  it("handles empty input", () => {
    expect(vectorToBlob([]).byteLength).toBe(0);
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
