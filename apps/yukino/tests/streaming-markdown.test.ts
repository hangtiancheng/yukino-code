import { stableStreamingPrefix } from "@yukino.js/ui/streaming-markdown.js";
import { describe, expect, it } from "vitest";

describe("stable streaming blocks", () => {
  it("holds the final list across blank lines and continuation items", () => {
    const paragraph = "Introduction. ".repeat(180) + "\n\n";
    const list = "1. first\n\n2. second\n\n";
    expect(stableStreamingPrefix(paragraph + list)).toBe(paragraph);
    expect(stableStreamingPrefix(paragraph + list + "3. third")).toBe(
      paragraph,
    );
  });

  it("retains reference links so future definitions can restyle them", () => {
    const paragraph = "See [the guide][guide]. ".repeat(150) + "\n\n";
    expect(stableStreamingPrefix(paragraph + "Next")).toBe("");
    expect(
      stableStreamingPrefix(paragraph + "[guide]: https://example.com\n\nNext"),
    ).toBe("");
  });

  it("does not split a paragraph or table that can still grow", () => {
    const paragraph = "An unfinished sentence 中文 ".repeat(150);
    expect(stableStreamingPrefix(paragraph)).toBe("");
    const table =
      "| Name | Value |\n| --- | --- |\n" + "| key | value |\n".repeat(200);
    expect(stableStreamingPrefix(table)).toBe("");
  });
});
