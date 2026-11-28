import { inputBoundary, type PasteStore } from "@/ui/input-paste.js";

export interface TextEditState {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
}

export type TextEditAction =
  "home" | "end" | "left" | "right" | "backspace" | "delete";

export function editText(
  state: TextEditState,
  action: TextEditAction,
  pastes?: PasteStore,
): TextEditState {
  const lines = [...state.lines];
  let { cursorLine, cursorCol } = state;
  const line = lines[cursorLine] ?? "";
  switch (action) {
    case "home":
      cursorCol = 0;
      break;
    case "end":
      cursorCol = line.length;
      break;
    case "left":
    case "backspace":
      if (cursorCol > 0) {
        const previous = inputBoundary(line, cursorCol, "previous", pastes);
        if (action === "backspace") {
          lines[cursorLine] = line.slice(0, previous) + line.slice(cursorCol);
        }
        cursorCol = previous;
      } else if (cursorLine > 0) {
        cursorCol = lines[cursorLine - 1].length;
        if (action === "backspace") {
          lines[cursorLine - 1] += line;
          lines.splice(cursorLine, 1);
        }
        cursorLine--;
      }
      break;
    case "right":
    case "delete":
      if (cursorCol < line.length) {
        const next = inputBoundary(line, cursorCol, "next", pastes);
        if (action === "delete") {
          lines[cursorLine] = line.slice(0, cursorCol) + line.slice(next);
        } else {
          cursorCol = next;
        }
      } else if (cursorLine < lines.length - 1) {
        if (action === "delete") {
          lines[cursorLine] += lines[cursorLine + 1];
          lines.splice(cursorLine + 1, 1);
        } else {
          cursorLine++;
          cursorCol = 0;
        }
      }
      break;
  }
  return { lines, cursorLine, cursorCol };
}
