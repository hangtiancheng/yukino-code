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

import { visibleWidth, wrapWordsToLines } from "./terminal-text.js";

/** cli-table3's default padding-left + padding-right, in terminal columns. */
const CELL_PADDING = 2;

/** One content column plus the cell padding: the narrowest usable column. */
const MIN_CELL_WIDTH = CELL_PADDING + 1;

export interface FittedTable {
  /** Column widths in terminal columns, cell padding included. */
  columnWidths: number[];
  /** The same rows, with every cell wrapped to its column. */
  rows: string[][];
}

/**
 * Lay out a table so the rendered block stays within `width` columns.
 *
 * cli-table3 sizes each column to its unwrapped content, so wide cells push the
 * table past the terminal and the Markdown renderer has to drop it back to raw
 * text. Shrinking the widest columns in turn keeps the table readable — narrow
 * columns stay narrow while prose columns wrap — and wrapping the cells here
 * rather than letting cli-table3 do it keeps wide characters and overlong words
 * inside their column: cli-table3's word wrap never breaks an overlong word,
 * and its char-level fallback counts UTF-16 units, not columns.
 *
 * Returns undefined when not even one content column per column fits; the
 * caller then falls back to raw text.
 */
export function fitTableToWidth(
  rows: string[][],
  columnCount: number,
  width: number,
): FittedTable | undefined {
  // One vertical border between the columns and on both outer edges.
  const available = width - (columnCount + 1);
  if (columnCount < 1 || available < columnCount * MIN_CELL_WIDTH) {
    return undefined;
  }

  const columnWidths = Array.from(
    { length: columnCount },
    (_, column) =>
      Math.max(0, ...rows.map((row) => cellWidth(row[column] ?? ""))) +
      CELL_PADDING,
  );

  let total = columnWidths.reduce((sum, column) => sum + column, 0);
  while (total > available) {
    const widest = widestColumn(columnWidths);
    if (widest === -1) {
      return undefined;
    }
    columnWidths[widest]--;
    total--;
  }

  const wrapped = rows.map((row) =>
    Array.from({ length: columnCount }, (_, column) =>
      wrapWordsToLines(
        row[column] ?? "",
        columnWidths[column] - CELL_PADDING,
      ).join("\n"),
    ),
  );

  return { columnWidths, rows: wrapped };
}

/** Width of the widest line of a cell, in terminal columns. */
function cellWidth(cell: string): number {
  return Math.max(0, ...cell.split("\n").map(visibleWidth));
}

/** Index of the widest column that can still give up a column, or -1. */
function widestColumn(columnWidths: number[]): number {
  let widest = -1;
  for (const [column, width] of columnWidths.entries()) {
    if (width <= MIN_CELL_WIDTH) {
      continue;
    }
    if (widest === -1 || width > columnWidths[widest]) {
      widest = column;
    }
  }
  return widest;
}
