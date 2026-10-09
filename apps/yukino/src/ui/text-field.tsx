import { Box, Text, useBoxMetrics, useInput, usePaste } from "ink";
import type { DOMElement } from "ink";
import { useMemo, useRef } from "react";
import type { SetStateAction } from "react";

import { CursorText } from "./cursor-text.js";
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
import {
  useAvailableRows,
  useTerminalDimensions,
} from "./use-terminal-layout.js";

interface TextFieldProps {
  /** Draft restored when the field mounts (e.g. re-entering "Other" mode). */
  initialValue?: string;
  /** When false the field still renders but ignores input. */
  isActive?: boolean;
  /** Columns consumed to the left of the text (dialog indentation). */
  indent?: number;
  /** Whether line breaks can be inserted. */
  multiline?: boolean;
  /** Prefix rendered before the first visual row, e.g. "→ ". */
  prompt?: string;
  /** Called with the joined draft after every edit so the parent can persist
   *  it across unmounts (callers mount the field conditionally). */
  onChange?: (value: string) => void;
  /** Enter submits the current draft. */
  onSubmit: (value: string) => void;
  /** Escape bubbles to the parent (e.g. leave free-text mode). */
  onEscape?: () => void;
  onBoundary?: (direction: -1 | 1) => void;
  onTab?: (value: string, shift: boolean) => void;
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
  multiline = true,
  prompt = "",
  onChange,
  onSubmit,
  onEscape,
  onBoundary,
  onTab,
}: TextFieldProps) {
  const { columns, rows: terminalRows } = useTerminalDimensions();
  const availableRows = useAvailableRows();
  const ref = useRef<DOMElement>(null);
  const metrics = useBoxMetrics(ref);
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
    setLines: updateLines,
    cursorLine,
    setCursorLine,
    cursorCol,
    setCursorCol,
    getDraft,
  } = useInputDraft(initialDraft);
  const preferredColumnRef = useRef<{ width: number; column: number } | null>(
    null,
  );

  const rowWidth = Math.max(
    1,
    (metrics.hasMeasured ? metrics.width : columns - 3) -
      indent -
      visibleWidth(prompt),
  );

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const setLines = (value: SetStateAction<string[]>) => {
    updateLines(value);
    onChangeRef.current?.(getDraft().lines.join("\n"));
  };

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

  usePaste(
    (text) => {
      const normalized = text.replace(/\r\n?/g, "\n");
      insertText(multiline ? normalized : normalized.replace(/\n/g, " "));
    },
    { isActive },
  );

  useInput(
    (input, key) => {
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
        onTab?.(lines.join("\n"), key.shift);
        return;
      }

      const hasLineBreak = input.includes("\r") || input.includes("\n");
      const hasReturn = key.return || hasLineBreak;
      const cleanInput = input.replace(/[\r\n]/g, "");

      // A chunk containing line breaks plus other content is a paste, not an
      // Enter press (Enter arrives as a lone "\r", "\n", or "\r\n").
      const isLoneEnter = input === "\r" || input === "\n" || input === "\r\n";
      if (hasLineBreak && !isLoneEnter) {
        const pasted = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        insertText(multiline ? pasted : pasted.replace(/\n/g, " "));
        return;
      }

      // Shift+Enter or Ctrl+J → newline
      if (
        multiline &&
        hasReturn &&
        (key.shift || (key.ctrl && input === "\n"))
      ) {
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

      if (key.home || (key.ctrl && input === "a")) {
        setCursorCol(0);
        return;
      }
      if (key.end || (key.ctrl && input === "e")) {
        setCursorCol((lines[cursorLine] ?? "").length);
        return;
      }

      if (key.leftArrow || (key.ctrl && input === "b")) {
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

      if (key.rightArrow || (key.ctrl && input === "f")) {
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
        } else {
          onBoundary?.(direction);
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
  const maxRows = Math.max(
    1,
    Math.min(Math.floor(terminalRows * 0.3), availableRows - 2),
  );
  const start = Math.max(
    0,
    Math.min(
      visualCursor.row - Math.floor(maxRows / 2),
      inputRows.length - maxRows,
    ),
  );
  const visibleRows = inputRows.slice(start, start + maxRows);

  return (
    <Box ref={ref} flexDirection="column" paddingLeft={indent} width="100%">
      {start > 0 && availableRows >= 3 ? (
        <Text color={THEME.dim} wrap="truncate-end">
          ↑ {start} more lines
        </Text>
      ) : null}
      {visibleRows.map((row, index) => {
        const rowIndex = start + index;
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
          <CursorText
            key={rowIndex}
            active={isActive}
            before={
              <>
                {head}
                {before}
              </>
            }
            current={caret.text}
            after={after}
          />
        );
      })}
      {start + visibleRows.length < inputRows.length && availableRows >= 3 ? (
        <Text color={THEME.dim} wrap="truncate-end">
          ↓ {inputRows.length - start - visibleRows.length} more lines
        </Text>
      ) : null}
    </Box>
  );
}
