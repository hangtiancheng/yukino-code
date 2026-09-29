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

import { Box, Text, useInput, useStdout } from "ink";
import { useEffect, useMemo, useRef } from "react";

import { useInputDraft } from "./input-draft.js";
import type { InputDraft } from "./input-draft.js";
import {
  layoutInputRows,
  locateInputCursor,
  moveInputVertically,
} from "./input-navigation.js";
import { inputBoundary } from "./input-paste.js";
import { THEME } from "./styles.js";
import { visibleWidth } from "./terminal-text.js";

interface TextFieldProps {
  /** Draft restored when the field mounts (e.g. re-entering "Other" mode). */
  initialValue?: string;
  /** When false the field still renders but ignores input. */
  isActive?: boolean;
  /** Columns consumed to the left of the text (dialog indentation). */
  indent?: number;
  /** Prefix rendered before the first visual row, e.g. "→ ". */
  prompt?: string;
  /** Called with the joined draft after every edit so the parent can persist
   *  it across unmounts (the field itself is unmounted when inactive). */
  onChange?: (value: string) => void;
  /** Enter submits the current draft. */
  onSubmit: (value: string) => void;
  /** Escape bubbles to the parent (e.g. leave free-text mode). */
  onEscape?: () => void;
}

/**
 * A compact free-text field for dialogs, sharing the composer's editing core:
 * grapheme-aware ←/→, ↑/↓ across hard-wrapped visual rows, Ctrl+A/E,
 * Delete/Backspace at the caret, Shift+Enter/Ctrl+J newlines and paste
 * insertion. The field grows vertically as the text wraps (same layout engine
 * as InputBox: layoutInputRows + locateInputCursor).
 */
export function TextField({
  initialValue = "",
  isActive = true,
  indent = 0,
  prompt = "",
  onChange,
  onSubmit,
  onEscape,
}: TextFieldProps) {
  const { stdout } = useStdout();
  const initialDraft = useRef<InputDraft | null>(null);
  if (initialDraft.current === null) {
    const initialLines = initialValue.split("\n");
    initialDraft.current = {
      lines: initialLines,
      cursorLine: initialLines.length - 1,
      cursorCol: initialLines[initialLines.length - 1]?.length ?? 0,
      historyIndex: -1,
      historyDraft: null,
    };
  }
  const {
    lines,
    setLines,
    cursorLine,
    setCursorLine,
    cursorCol,
    setCursorCol,
    getDraft,
  } = useInputDraft(initialDraft);
  const preferredColumnRef = useRef<{ width: number; column: number } | null>(
    null,
  );

  // SelectorFrame paddingX(1) + QuestionContent paddingLeft(1) eat 3 columns.
  const rowWidth = Math.max(
    1,
    (stdout.columns || 80) - indent - visibleWidth(prompt) - 3,
  );

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    onChangeRef.current?.(lines.join("\n"));
  }, [lines]);

  const insertText = (text: string) => {
    preferredColumnRef.current = null;
    const draft = getDraft();
    const cl = draft.cursorLine;
    const col = inputBoundary(draft.lines[cl] ?? "", draft.cursorCol, "clamp");
    const segments = text.split("\n");
    const lastLen = segments[segments.length - 1].length;
    setLines((prev) => {
      const updated = [...prev];
      const line = updated[cl] ?? "";
      const inserted = [...segments];
      inserted[0] = line.slice(0, col) + inserted[0];
      inserted[inserted.length - 1] =
        inserted[inserted.length - 1] + line.slice(col);
      updated.splice(cl, 1, ...inserted);
      return updated;
    });
    setCursorLine(cl + segments.length - 1);
    setCursorCol(segments.length === 1 ? col + lastLen : lastLen);
  };

  useInput(
    (input, key) => {
      // Filter out SGR mouse events
      if (input.includes("[<") && /\[<\d+;\d+;\d+[Mm]/.test(input)) {
        return;
      }
      // Ink can deliver another key before React commits the previous edit.
      const { lines, cursorLine, cursorCol } = getDraft();
      const isMultiline = lines.length > 1;
      if (!key.upArrow && !key.downArrow) {
        preferredColumnRef.current = null;
      }

      // Escape: key.escape or raw \x1b byte (tmux compat)
      if (key.escape || input === "\x1b") {
        onEscape?.();
        return;
      }

      // Tab belongs to the surrounding dialog (question/field navigation).
      if (key.tab) {
        return;
      }

      const hasLineBreak = input.includes("\r") || input.includes("\n");
      const hasReturn = key.return || hasLineBreak;
      const cleanInput = input.replace(/[\r\n]/g, "");

      // A chunk containing line breaks plus other content is a paste, not an
      // Enter press (Enter arrives as a lone "\r", "\n", or "\r\n").
      const isLoneEnter = input === "\r" || input === "\n" || input === "\r\n";
      if (hasLineBreak && !isLoneEnter) {
        insertText(input.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
        return;
      }

      // Shift+Enter or Ctrl+J → newline
      if (hasReturn && (key.shift || (key.ctrl && input === "\n"))) {
        const line = lines[cursorLine] ?? "";
        setLines((prev) => {
          const updated = [...prev];
          updated[cursorLine] = line.slice(0, cursorCol);
          updated.splice(cursorLine + 1, 0, line.slice(cursorCol));
          return updated;
        });
        setCursorLine(cursorLine + 1);
        setCursorCol(0);
        return;
      }

      if (hasReturn) {
        onSubmit(lines.join("\n"));
        return;
      }

      if (key.ctrl && input === "a") {
        setCursorCol(0);
        return;
      }
      if (key.ctrl && input === "e") {
        setCursorCol((lines[cursorLine] ?? "").length);
        return;
      }

      if (key.leftArrow) {
        if (cursorCol > 0) {
          setCursorCol(
            inputBoundary(lines[cursorLine] ?? "", cursorCol, "previous"),
          );
        } else if (isMultiline && cursorLine > 0) {
          setCursorLine(cursorLine - 1);
          setCursorCol((lines[cursorLine - 1] ?? "").length);
        }
        return;
      }

      if (key.rightArrow) {
        const lineLen = (lines[cursorLine] ?? "").length;
        if (cursorCol < lineLen) {
          setCursorCol(
            inputBoundary(lines[cursorLine] ?? "", cursorCol, "next"),
          );
        } else if (isMultiline && cursorLine < lines.length - 1) {
          setCursorLine(cursorLine + 1);
          setCursorCol(0);
        }
        return;
      }

      if (key.backspace || key.delete) {
        const line = lines[cursorLine] ?? "";
        if (key.delete && cursorCol < line.length) {
          const nextCol = inputBoundary(line, cursorCol, "next");
          setLines((prev) => {
            const updated = [...prev];
            const current = updated[cursorLine] ?? "";
            updated[cursorLine] =
              current.slice(0, cursorCol) + current.slice(nextCol);
            return updated;
          });
        } else if (key.backspace && cursorCol > 0) {
          const previousCol = inputBoundary(line, cursorCol, "previous");
          setLines((prev) => {
            const updated = [...prev];
            const l = updated[cursorLine] ?? "";
            updated[cursorLine] = l.slice(0, previousCol) + l.slice(cursorCol);
            return updated;
          });
          setCursorCol(previousCol);
        } else if (key.backspace && cursorLine > 0) {
          const prevLen = (lines[cursorLine - 1] ?? "").length;
          const cl = cursorLine;
          setLines((prev) => {
            const updated = [...prev];
            updated[cl - 1] = (updated[cl - 1] ?? "") + (updated[cl] ?? "");
            updated.splice(cl, 1);
            return updated;
          });
          setCursorLine(cl - 1);
          setCursorCol(prevLen);
        } else if (key.delete && cursorLine < lines.length - 1) {
          const cl = cursorLine;
          setLines((prev) => {
            const updated = [...prev];
            updated[cl] = (updated[cl] ?? "") + (updated[cl + 1] ?? "");
            updated.splice(cl + 1, 1);
            return updated;
          });
        }
        return;
      }

      if (key.upArrow || key.downArrow) {
        const direction = key.upArrow ? -1 : 1;
        const preferred = preferredColumnRef.current;
        const position = moveInputVertically(
          layoutInputRows(lines, rowWidth),
          cursorLine,
          cursorCol,
          direction,
          preferred?.width === rowWidth ? preferred.column : undefined,
        );
        if (position) {
          preferredColumnRef.current = {
            width: rowWidth,
            column: position.preferredColumn,
          };
          setCursorLine(position.cursorLine);
          setCursorCol(position.cursorCol);
        }
        return;
      }

      if (cleanInput && !key.ctrl && !key.meta) {
        insertText(cleanInput);
      }
    },
    { isActive },
  );

  const inputRows = useMemo(
    () => layoutInputRows(lines, rowWidth),
    [lines, rowWidth],
  );
  const visualCursor = locateInputCursor(inputRows, cursorLine, cursorCol);

  return (
    <Box flexDirection="column" paddingLeft={indent}>
      {inputRows.map((row, rowIndex) => {
        const head =
          rowIndex === 0 ? <Text color={THEME.dim}>{prompt}</Text> : undefined;
        if (rowIndex !== visualCursor.row) {
          return (
            <Text key={rowIndex} wrap="truncate-end">
              {head}
              {row.cells.map((cell) => cell.text).join("")}
            </Text>
          );
        }
        const before = row.cells
          .slice(0, visualCursor.cell)
          .map((cell) => cell.text)
          .join("");
        const caret = row.cells[visualCursor.cell];
        const after = row.cells
          .slice(visualCursor.cell + 1)
          .map((cell) => cell.text)
          .join("");
        return (
          <Text key={rowIndex} wrap="truncate-end">
            {head}
            {before}
            <Text inverse>{caret.text}</Text>
            {after}
          </Text>
        );
      })}
    </Box>
  );
}
