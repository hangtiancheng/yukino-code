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

import { layoutInputRows, locateInputCursor, moveInputVertically } from "@/ui/input-navigation.js";
import { collapsePaste, inputBoundary } from "@/ui/input-paste.js";
import { visibleWidth } from "@/ui/terminal-text.js";

describe("input visual-row navigation", () => {
  it("preserves the preferred cell column across short logical lines in both directions", () => {
    const rows = layoutInputRows(["abcdef", "x", "abcdef"], 20);
    const up = moveInputVertically(rows, 2, 5, -1);
    expect(up).toEqual({ cursorLine: 1, cursorCol: 1, preferredColumn: 5 });
    expect(moveInputVertically(rows, 1, 1, -1, up?.preferredColumn)).toEqual({
      cursorLine: 0,
      cursorCol: 5,
      preferredColumn: 5,
    });
    const down = moveInputVertically(rows, 0, 5, 1);
    expect(down).toEqual({ cursorLine: 1, cursorCol: 1, preferredColumn: 5 });
    expect(moveInputVertically(rows, 1, 1, 1, down?.preferredColumn)).toEqual({
      cursorLine: 2,
      cursorCol: 5,
      preferredColumn: 5,
    });
  });

  it("stops at the first and last visual rows", () => {
    const rows = layoutInputRows(["abc", "", "xyz"], 20);
    expect(moveInputVertically(rows, 0, 2, -1)).toBeUndefined();
    expect(moveInputVertically(rows, 2, 2, 1)).toBeUndefined();
    expect(moveInputVertically(rows, 0, 2, 1)).toEqual({
      cursorLine: 1,
      cursorCol: 0,
      preferredColumn: 2,
    });
  });

  it("uses display cells and never lands inside a CJK, emoji or combining grapheme", () => {
    const unicode = "ab界👩‍💻éz";
    const rows = layoutInputRows([unicode, "短", "abcdefg"], 20);
    expect(moveInputVertically(rows, 1, 1, -1, 5)).toEqual({
      cursorLine: 0,
      cursorCol: "ab界".length,
      preferredColumn: 5,
    });
    expect(moveInputVertically(rows, 1, 1, -1, 6)).toEqual({
      cursorLine: 0,
      cursorCol: "ab界👩‍💻".length,
      preferredColumn: 6,
    });
    expect(moveInputVertically(rows, 1, 1, -1, 7)).toEqual({
      cursorLine: 0,
      cursorCol: "ab界👩‍💻é".length,
      preferredColumn: 7,
    });
    expect(moveInputVertically(rows, 0, "ab界👩‍💻".length, 1)).toEqual({
      cursorLine: 1,
      cursorCol: 1,
      preferredColumn: 6,
    });
  });

  it("moves through soft-wrapped rows without introducing logical newlines", () => {
    const lines = ["abcdefghi"];
    const rows = layoutInputRows(lines, 4);
    expect(rows.map((row) => row.cells.map((cell) => cell.text).join(""))).toEqual([
      "abcd",
      "efgh",
      "i ",
    ]);
    expect(locateInputCursor(rows, 0, 9)).toEqual({
      row: 2,
      cell: 1,
      column: 1,
    });
    expect(moveInputVertically(rows, 0, 9, -1)).toEqual({
      cursorLine: 0,
      cursorCol: 5,
      preferredColumn: 1,
    });
    expect(moveInputVertically(rows, 0, 5, -1)).toEqual({
      cursorLine: 0,
      cursorCol: 1,
      preferredColumn: 1,
    });
    expect(moveInputVertically(rows, 0, 5, 1)).toEqual({
      cursorLine: 0,
      cursorCol: 9,
      preferredColumn: 1,
    });
    expect(lines).toEqual(["abcdefghi"]);
  });

  it("keeps an end caret on its own row after an exactly full line", () => {
    const rows = layoutInputRows(["abcd"], 4);
    expect(rows).toHaveLength(2);
    expect(locateInputCursor(rows, 0, 4)).toEqual({
      row: 1,
      cell: 0,
      column: 0,
    });
    expect(moveInputVertically(rows, 0, 4, -1)?.cursorCol).toBe(0);
    expect(moveInputVertically(rows, 0, 0, 1)?.cursorCol).toBe(4);
  });

  it("keeps paste markers atomic, including when a marker exceeds the row width", () => {
    const paste = collapsePaste("x".repeat(1001));
    const line = `ab${paste.text}cd`;
    const rows = layoutInputRows([line], 4, paste.store);
    expect(rows.map((row) => row.cells.map((cell) => cell.text).join(""))).toEqual([
      "ab",
      "[pa…",
      "cd ",
    ]);
    expect(moveInputVertically(rows, 0, line.length, -1)?.cursorCol).toBe(2);
    expect(moveInputVertically(rows, 0, 2, 1)?.cursorCol).toBe(2 + paste.text.length);
    for (const row of rows) {
      for (const cell of row.cells) {
        expect(inputBoundary(line, cell.offset, "clamp", paste.store)).toBe(cell.offset);
      }
    }
  });

  it.each([1, 20, 40, 80])("fits graphemes and paste atoms into %i cells", (width) => {
    const paste = collapsePaste("x".repeat(1001));
    const line = `${"界👩‍💻é ".repeat(25)}${paste.text}`;
    const rows = layoutInputRows([line], width, paste.store);
    for (const row of rows) {
      expect(row.width).toBeLessThanOrEqual(width);
      expect(visibleWidth(row.cells.map((cell) => cell.text).join(""))).toBe(row.width);
      for (const cell of row.cells) {
        expect(inputBoundary(line, cell.offset, "clamp", paste.store)).toBe(cell.offset);
        expect(cell.text).not.toMatch(/[\ud800-\udfff]/u);
      }
    }
    expect(locateInputCursor(rows, 0, line.length).row).toBe(rows.length - 1);
  });

  it("reflows narrow resizes without changing logical positions or content", () => {
    const lines = ["abcdefghijk"];
    expect(locateInputCursor(layoutInputRows(lines, 20), 0, 9).column).toBe(9);
    expect(locateInputCursor(layoutInputRows(lines, 4), 0, 9)).toEqual({
      row: 2,
      cell: 1,
      column: 1,
    });
    expect(locateInputCursor(layoutInputRows(lines, 1), 0, 9)).toEqual({
      row: 9,
      cell: 0,
      column: 0,
    });
    expect(lines).toEqual(["abcdefghijk"]);
  });

  it("does not split ANSI sequences into visible text or count them as cells", () => {
    const line = "\x1b[31m界a\x1b[0m";
    const rows = layoutInputRows(["plain", line], 3);
    expect(
      rows
        .filter((row) => row.line === 1)
        .map((row) => row.cells.map((cell) => cell.text).join("")),
    ).toEqual(["界a", " "]);
    expect(locateInputCursor(rows, 1, 0)).toEqual({
      row: 2,
      cell: 0,
      column: 0,
    });
    expect(locateInputCursor(rows, 1, "\x1b[31m界".length)).toEqual({
      row: 2,
      cell: 1,
      column: 2,
    });
  });
});
