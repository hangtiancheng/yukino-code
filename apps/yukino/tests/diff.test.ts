import { describe, it, expect } from "vitest";

import { buildDiff, buildEditDiff } from "@/tools/diff.js";

describe("buildDiff", () => {
  it("does not count unchanged lines between equal-size edits as replacements", () => {
    const { text, additions, removals } = buildDiff(
      "first\nkeep\nlast",
      "FIRST\nkeep\nLAST",
    );
    expect(additions).toBe(2);
    expect(removals).toBe(2);
    expect(text).toContain("     2  keep");
    expect(text).not.toContain("-    2  keep");
  });
  it("reports a single-line change with correct counts and markers", () => {
    const oldContent = "a\nb\nc\nd\ne\n";
    const newContent = "a\nb\nX\nd\ne\n";
    const { text, additions, removals } = buildDiff(oldContent, newContent);
    expect(additions).toBe(1);
    expect(removals).toBe(1);
    expect(text).toContain("-    3  c");
    expect(text).toContain("+    3  X");
    // Context lines carry new-file line numbers (equal to the old-file numbers
    // here because this edit does not change the line count)
    expect(text).toContain("   2  b");
    expect(text).toContain("   4  d");
  });

  it("handles a pure insertion (no removals)", () => {
    const { text, additions, removals } = buildDiff("a\nb\n", "a\nX\nY\nb\n");
    expect(removals).toBe(0);
    expect(additions).toBe(2);
    expect(text).toContain("+    2  X");
    expect(text).toContain("+    3  Y");
  });

  it("handles a pure deletion (no additions)", () => {
    const { text, additions, removals } = buildDiff("a\nb\nc\n", "a\nc\n");
    expect(additions).toBe(0);
    expect(removals).toBe(1);
    expect(text).toContain("-    2  b");
  });

  it("numbers trailing context from the new file after unequal edits", () => {
    const oldContent = [
      "before",
      "remove-one",
      "remove-two",
      "tail-one",
      "tail-two",
    ].join("\n");
    const newContent = [
      "before",
      "add-one",
      "add-two",
      "add-three",
      "tail-one",
      "tail-two",
    ].join("\n");

    const { text, additions, removals } = buildDiff(oldContent, newContent);
    const lines = text.split("\n");

    expect(additions).toBe(3);
    expect(removals).toBe(2);
    expect(lines.find((line) => line.endsWith("  tail-one"))?.trim()).toBe(
      "5  tail-one",
    );
    expect(lines.find((line) => line.endsWith("  tail-two"))?.trim()).toBe(
      "6  tail-two",
    );
  });

  it("trims unchanged prefix/suffix so unrelated lines don't show up as changed", () => {
    const oldLines = Array.from({ length: 20 }, (_, i) => `line${String(i)}`);
    const newLines = [...oldLines];
    newLines[10] = "CHANGED";
    const { text } = buildDiff(oldLines.join("\n"), newLines.join("\n"));
    expect(text).not.toContain("line0\n");
    expect(text).toContain("-   11  line10");
    expect(text).toContain("+   11  CHANGED");
  });

  it("caps output for very large diffs instead of dumping everything", () => {
    const oldLines = Array.from({ length: 500 }, (_, i) => `old${String(i)}`);
    const newLines = Array.from({ length: 500 }, (_, i) => `new${String(i)}`);
    const { text } = buildDiff(oldLines.join("\n"), newLines.join("\n"));
    expect(text).toContain("truncated");
    expect(text.split("\n").length).toBeLessThanOrEqual(201);
  });
});

describe("buildEditDiff", () => {
  it("accounts for deletions when numbering later diff regions", () => {
    const lines = Array.from(
      { length: 100 },
      (_, index) => `line-${String(index)}`,
    );
    const content = lines.join("\n");
    const target = "line-90";
    const start = content.indexOf(target);
    const { text, additions, removals } = buildEditDiff(content, [
      { start: 0, end: "line-0\nline-1\n".length, text: "" },
      { start, end: start + target.length, text: "changed" },
    ]);
    expect(additions).toBe(1);
    expect(removals).toBe(3);
    expect(text).toContain("-   91  line-90");
    expect(text).toContain("+   89  changed");
    expect(text).toContain("    90  line-91");
    expect(text).not.toContain("line-50");
  });

  it("caps the combined output of many separate diff regions", () => {
    const lines = Array.from(
      { length: 1_000 },
      (_, index) => `line-${String(index)}`,
    );
    const content = lines.join("\n");
    const replacements = Array.from({ length: 80 }, (_, index) => {
      const target = `line-${String(index * 12)}\n`;
      const start = content.indexOf(target);
      return { start, end: start + target.length, text: "changed\n" };
    });
    const { text, additions, removals } = buildEditDiff(content, replacements);
    expect(additions).toBe(80);
    expect(removals).toBe(80);
    expect(text).toContain("diff truncated at 200 lines");
    expect(text.split("\n").length).toBeLessThanOrEqual(201);
  });
});
