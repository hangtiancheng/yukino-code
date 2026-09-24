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

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SetStateAction } from "react";

import type { PasteStore } from "./input-paste.js";

interface InputPosition {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
  pastes?: PasteStore;
}

export interface InputDraft extends InputPosition {
  historyIndex: number;
  historyDraft: InputPosition | null;
}

export function useInputDraft(draftRef?: { current: InputDraft | null }) {
  const [draft, setDraft] = useState<InputDraft>(() => {
    const saved = draftRef?.current;
    return saved
      ? {
          ...saved,
          lines: [...saved.lines],
          historyDraft: saved.historyDraft
            ? { ...saved.historyDraft, lines: [...saved.historyDraft.lines] }
            : null,
        }
      : {
          lines: [""],
          cursorLine: 0,
          cursorCol: 0,
          historyIndex: -1,
          historyDraft: null,
        };
  });
  const latest = useRef(draft);

  useLayoutEffect(() => {
    if (draftRef) {
      draftRef.current = latest.current;
    }
  }, [draftRef]);

  const update = useCallback(
    <Field extends keyof InputDraft>(
      field: Field,
      value: SetStateAction<InputDraft[Field]>,
    ) => {
      const previous = latest.current;
      const next = {
        ...previous,
        [field]: typeof value === "function" ? value(previous[field]) : value,
      };
      if (field === "pastes" && next.pastes === undefined) {
        delete next.pastes;
      }
      latest.current = next;
      // Persist before scheduling React: a selector can unmount the editor in
      // the same event, before a render or effect has a chance to save it.
      if (draftRef) {
        draftRef.current = next;
      }
      setDraft(next);
    },
    [draftRef],
  );

  const setters = useMemo(
    () => ({
      getDraft: () => latest.current,
      setLines: (value: SetStateAction<string[]>) => {
        update("lines", value);
      },
      setCursorLine: (value: SetStateAction<number>) => {
        update("cursorLine", value);
      },
      setCursorCol: (value: SetStateAction<number>) => {
        update("cursorCol", value);
      },
      setHistoryIndex: (value: SetStateAction<number>) => {
        update("historyIndex", value);
      },
      setHistoryDraft: (value: InputPosition | null) => {
        update("historyDraft", value);
      },
      setPastes: (value: PasteStore | undefined) => {
        update("pastes", value);
      },
    }),
    [update],
  );

  return { ...draft, ...setters };
}
