import { describe, expect, it } from "vitest";

import { escapeTagValue, float32ToBuffer, sha256 } from "@/tools/docs/utils.js";

describe("escapeTagValue", () => {
  it("escapes hyphens, dots and slashes in filenames", () => {
    expect(escapeTagValue("upload-test.v2.md")).toBe("upload\\-test\\.v2\\.md");
    expect(escapeTagValue("guides/setup.md")).toBe("guides\\/setup\\.md");
  });

  it("keeps letters, digits, underscore and CJK untouched", () => {
    expect(escapeTagValue("abc_123")).toBe("abc_123");
    expect(escapeTagValue("知識ベース")).toBe("知識ベース");
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
    const back = Array.from(
      new Float32Array(buf.buffer, buf.byteOffset, values.length),
    );
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
