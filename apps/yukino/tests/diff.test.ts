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

import { describe, it, expect } from "vitest";

import { buildDiff } from "@/tools/diff.js";

describe("buildDiff", () => {
  it("reports a single-line change with correct counts and markers", () => {
    const oldContent = "a\nb\nc\nd\ne\n";
    const newContent = "a\nb\nX\nd\ne\n";
    const { text, additions, removals } = buildDiff(oldContent, newContent);
    expect(additions).toBe(1);
    expect(removals).toBe(1);
    expect(text).toContain("-    3  c");
    expect(text).toContain("+    3  X");
    // Context lines should carry the correct original line numbers
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
    expect(text.split("\n").length).toBeLessThan(500);
  });
});
