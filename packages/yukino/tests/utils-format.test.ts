import { describe, expect, it } from "vitest";

import { asErrorString, asString } from "@/utils/index.js";

describe("shared value formatting", () => {
  it("keeps native messages and stringifies other values", () => {
    expect(asErrorString(new Error("detail"))).toBe("detail");
    expect(asErrorString(new Error(""))).toBe("");
    expect(asErrorString(Symbol("detail"))).toBe("Symbol(detail)");
    expect(asString(0)).toBe("0");
  });

  it("returns a readable fallback for values that cannot be coerced to text", () => {
    const value: unknown = Object.create(null);
    expect(asString(value)).toBe("[unprintable value]");
    expect(asErrorString(value)).toBe("[unprintable value]");
  });
});
