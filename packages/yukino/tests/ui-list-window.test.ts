import { describe, expect, it } from "vitest";

import { getListWindowStart } from "@/ui/list-window.js";

describe("UI v2 list window", () => {
  it("keeps the first page stable while its items are selected", () => {
    expect(getListWindowStart(20, 0, 8)).toBe(0);
    expect(getListWindowStart(20, 7, 8)).toBe(0);
  });

  it("scrolls to keep later selections visible", () => {
    expect(getListWindowStart(20, 8, 8)).toBe(1);
    expect(getListWindowStart(20, 19, 8)).toBe(12);
  });
});
