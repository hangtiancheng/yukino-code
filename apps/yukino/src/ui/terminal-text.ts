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

import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

export function visibleWidth(text: string): number {
  return stringWidth(text);
}

export function truncateToWidth(
  text: string,
  width: number,
  suffix = "…",
): string {
  const columns = Math.max(0, Math.floor(width));
  if (visibleWidth(text) <= columns) {
    return text;
  }
  const ending = sliceAnsi(suffix, 0, columns);
  return (
    sliceAnsi(text, 0, Math.max(0, columns - visibleWidth(ending))) + ending
  );
}

export function wrapToLines(text: string, width: number): string[] {
  return wrapAnsi(text, Math.max(1, Math.floor(width)), {
    hard: true,
    wordWrap: false,
    trim: false,
  }).split("\n");
}

/**
 * Like {@link wrapToLines}, but breaks at word boundaries where possible and
 * only splits a word (or space-less text such as Chinese) when it cannot fit.
 */
export function wrapWordsToLines(text: string, width: number): string[] {
  return wrapAnsi(text, Math.max(1, Math.floor(width)), {
    hard: true,
    wordWrap: true,
    trim: true,
  }).split("\n");
}

/** Tab stop interval terminals use when advancing past a TAB character. */
const TAB_SIZE = 8;

/**
 * Replace TAB characters with the spaces a terminal would render them as.
 *
 * string-width counts a TAB as zero columns, but terminals advance to the next
 * 8-column stop. Text that fits under the wrong measurement is left unwrapped by
 * Ink and then fills the row past the terminal width, so the surplus columns
 * wrap onto a bogus extra line.
 */
export function expandTabs(text: string, tabSize = TAB_SIZE): string {
  if (!text.includes("\t")) {
    return text;
  }
  return text
    .split("\n")
    .map((line) => {
      if (!line.includes("\t")) {
        return line;
      }
      const segments = line.split("\t");
      let expanded = segments[0];
      for (const segment of segments.slice(1)) {
        const advance = tabSize - (visibleWidth(expanded) % tabSize);
        expanded += " ".repeat(advance) + segment;
      }
      return expanded;
    })
    .join("\n");
}

/** Return the UTF-16 index immediately before the grapheme at `index`. */
export function previousGraphemeBoundary(text: string, index: number): number {
  const bounded = Math.max(0, Math.min(index, text.length));
  let previous = 0;
  for (const segment of graphemeSegmenter.segment(text)) {
    if (segment.index >= bounded) {
      return previous;
    }
    previous = segment.index;
  }
  return previous;
}

/** Return the UTF-16 index immediately after the grapheme at `index`. */
export function nextGraphemeBoundary(text: string, index: number): number {
  const bounded = Math.max(0, Math.min(index, text.length));
  for (const segment of graphemeSegmenter.segment(text)) {
    if (segment.index >= bounded) {
      return segment.index === bounded
        ? segment.index + segment.segment.length
        : segment.index;
    }
    if (segment.index + segment.segment.length > bounded) {
      return segment.index + segment.segment.length;
    }
  }
  return text.length;
}

/** Clamp a cursor index to the nearest grapheme boundary on its left. */
export function clampToGraphemeBoundary(text: string, index: number): number {
  const bounded = Math.max(0, Math.min(index, text.length));
  return nextGraphemeBoundary(text, previousGraphemeBoundary(text, bounded)) ===
    bounded
    ? bounded
    : previousGraphemeBoundary(text, bounded);
}
