import { expect, it } from "vitest";

import { extractJsonOutput, stableStringify } from "@/utils/json.js";

it("uses deterministic JSON ordering without conflating arrays or missing properties", () => {
  expect(stableStringify({ b: { z: 1, a: 2 }, A: 3 })).toBe(
    stableStringify({ A: 3, b: { a: 2, z: 1 } }),
  );
  expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  expect(stableStringify({ a: undefined })).toBe("{}");
  expect(stableStringify({ a: null })).not.toBe("{}");
});

it("rejects circular objects and BigInt rather than silently changing fingerprint inputs", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(() => stableStringify(circular)).toThrow();
  expect(() => stableStringify({ value: 1n })).toThrow();
});

it("extracts complete JSON with quoted braces and fences, rejecting truncated JSON", () => {
  expect(
    extractJsonOutput('Result: ```json\n{"selected":[{"path":"a}b"}]}\n```'),
  ).toEqual({ selected: [{ path: "a}b" }] });
  expect(extractJsonOutput('First {"id":1} then {"id":2}')).toEqual({ id: 2 });
  expect(() => extractJsonOutput('Result: {"selected":[')).toThrow();
});
