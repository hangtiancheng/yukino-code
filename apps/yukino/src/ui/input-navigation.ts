import ansiRegex from "ansi-regex";

import { inputBoundary } from "./input-paste.js";
import type { PasteStore } from "./input-paste.js";
import { truncateToWidth, visibleWidth } from "./terminal-text.js";

interface InputCell {
  /** UTF-16 offset in the stored logical line, not a display column. */
  offset: number;
  text: string;
  width: number;
}

export interface InputRow {
  line: number;
  cells: InputCell[];
  width: number;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Hard-wrap editable atoms, keeping the stored draft independent of terminal size. */
export function layoutInputRows(
  lines: string[],
  width: number,
  pastes?: PasteStore,
): InputRow[] {
  const columns = Math.max(1, Math.floor(width));
  const rows: InputRow[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    let row: InputRow = { line: lineIndex, cells: [], width: 0 };
    rows.push(row);
    const append = (offset: number, raw: string) => {
      // A wide grapheme cannot fit a one-cell terminal. Show a placeholder, not
      // half a grapheme. Oversized paste markers are clipped as one editable atom.
      const display =
        raw === "\t" ? "    " : visibleWidth(raw) === 0 ? " " : raw;
      const text =
        visibleWidth(display) > columns
          ? truncateToWidth(display, columns)
          : display;
      const cellWidth = visibleWidth(text);
      if (row.width > 0 && row.width + cellWidth > columns) {
        row = { line: lineIndex, cells: [], width: 0 };
        rows.push(row);
      }
      row.cells.push({ offset, text, width: cellWidth });
      row.width += cellWidth;
    };

    // ANSI is not editable display content. Skip whole sequences while retaining
    // their original offsets so layout never exposes partial escape sequences.
    const escapes = new Map(
      Array.from(line.matchAll(ansiRegex()), (match) => [
        match.index,
        match[0].length,
      ]),
    );
    let next = 0;
    for (const part of segmenter.segment(line)) {
      if (part.index < next) {
        continue;
      }
      const escapeLength = escapes.get(part.index);
      if (escapeLength !== undefined) {
        next = part.index + escapeLength;
        continue;
      }
      next =
        pastes && part.segment === "["
          ? inputBoundary(line, part.index, "next", pastes)
          : part.index + part.segment.length;
      append(part.index, line.slice(part.index, next));
    }
    // Reserve the real end-of-line caret cell, including after an exactly full
    // row. Its position must not change when focus moves to another logical line.
    append(line.length, " ");
  }
  return rows;
}

export function locateInputCursor(
  rows: InputRow[],
  cursorLine: number,
  cursorCol: number,
) {
  const firstRow = Math.max(
    0,
    rows.findIndex((row) => row.line === cursorLine),
  );
  let position = { row: firstRow, cell: 0, column: 0 };
  for (const [rowIndex, row] of rows.entries()) {
    if (row.line !== cursorLine) {
      continue;
    }
    let column = 0;
    for (const [cellIndex, cell] of row.cells.entries()) {
      if (cell.offset > cursorCol) {
        return position;
      }
      position = { row: rowIndex, cell: cellIndex, column };
      column += cell.width;
    }
  }
  return position;
}

export function moveInputVertically(
  rows: InputRow[],
  cursorLine: number,
  cursorCol: number,
  direction: -1 | 1,
  preferredColumn?: number,
) {
  const current = locateInputCursor(rows, cursorLine, cursorCol);
  const target = rows[current.row + direction];
  if (!target) {
    return undefined;
  }
  const column = preferredColumn ?? current.column;
  let offset = target.cells[0].offset;
  let displayColumn = 0;
  for (const cell of target.cells) {
    if (displayColumn > column) {
      break;
    }
    offset = cell.offset;
    displayColumn += cell.width;
  }
  return {
    cursorLine: target.line,
    cursorCol: offset,
    preferredColumn: column,
  };
}
