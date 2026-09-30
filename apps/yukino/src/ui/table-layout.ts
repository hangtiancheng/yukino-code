import chalk from "chalk";

import { THEME } from "./styles.js";
import {
  truncateToWidth,
  visibleWidth,
  wrapWordsToLines,
} from "./terminal-text.js";

/** One space of padding on each side of a cell, in terminal columns. */
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
 * Columns are sized to their unwrapped content, so wide cells push the table
 * past the terminal and the Markdown renderer has to drop it back to raw text.
 * Shrinking the widest columns in turn keeps the table readable — narrow
 * columns stay narrow while prose columns wrap — and wrapping the cells here
 * rather than at draw time keeps wide characters and overlong words inside
 * their column.
 *
 * Returns undefined when not even one content column per column fits; the
 * table then renders at its natural width, and the Markdown renderer drops it
 * to raw text when it still overflows.
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

/**
 * Draw a grid table with a header row, box borders and one space of cell
 * padding. Cells may contain ANSI styles and embedded newlines; when
 * `columnWidths` is given (from {@link fitTableToWidth}, padding included)
 * they are trusted as-is, otherwise each column is sized to its content.
 */
export function renderTable(rows: string[][], columnWidths?: number[]): string {
  const columnCount = Math.max(0, ...rows.map((row) => row.length));
  if (columnCount === 0) {
    return "";
  }

  const widths = Array.from(
    { length: columnCount },
    (_, column) =>
      columnWidths?.[column] ??
      Math.max(0, ...rows.map((row) => cellWidth(row[column] ?? ""))) +
        CELL_PADDING,
  );
  const contentWidths = widths.map((width) =>
    Math.max(0, width - CELL_PADDING),
  );

  const border = (left: string, mid: string, right: string): string =>
    chalk.hex(THEME.muted)(
      left + widths.map((width) => "─".repeat(width)).join(mid) + right,
    );

  const lines = [border("┌", "┬", "┐")];
  rows.forEach((row, rowIndex) => {
    if (rowIndex > 0) {
      lines.push(border("├", "┼", "┤"));
    }
    const cells = Array.from({ length: columnCount }, (_, column) =>
      (row[column] ?? "").split("\n"),
    );
    const height = Math.max(1, ...cells.map((cell) => cell.length));
    for (let line = 0; line < height; line++) {
      const parts = cells.map((cell, column) => {
        const content = padCell(
          truncateToWidth(cell[line] ?? "", contentWidths[column]),
          contentWidths[column],
        );
        return rowIndex === 0 ? chalk.hex(THEME.mdHeading)(content) : content;
      });
      const vertical = chalk.hex(THEME.muted)("│");
      lines.push(vertical + parts.join(vertical) + vertical);
    }
  });
  lines.push(border("└", "┴", "┘"));

  return lines.join("\n");
}

function padCell(content: string, width: number): string {
  return (
    " " + content + " ".repeat(Math.max(0, width - visibleWidth(content))) + " "
  );
}
