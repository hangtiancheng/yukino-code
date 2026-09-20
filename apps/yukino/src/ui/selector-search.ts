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

import type { Key } from "ink";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Only provider/session selectors call this; action dialogs retain their own shortcuts.
export function updateSelectorQuery(
  query: string,
  input: string,
  key: Key,
): string {
  if (key.ctrl && input === "u") {
    return "";
  }
  if (
    key.ctrl ||
    key.meta ||
    key.super ||
    key.hyper ||
    key.tab ||
    key.escape ||
    key.return ||
    key.upArrow ||
    key.downArrow ||
    key.leftArrow ||
    key.rightArrow ||
    key.pageUp ||
    key.pageDown ||
    key.home ||
    key.end
  ) {
    return query;
  }
  if (key.backspace || key.delete) {
    return Array.from(graphemes.segment(query), ({ segment }) => segment)
      .slice(0, -1)
      .join("");
  }
  if (input.includes("\u001b") || /\[<\d+;\d+;\d+[Mm]/.test(input)) {
    return query;
  }
  return query + input.replace(/[\r\n\t]+/g, " ").replace(/\p{Cc}/gu, "");
}
