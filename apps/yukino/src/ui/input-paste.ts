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

import {
  clampToGraphemeBoundary,
  nextGraphemeBoundary,
  previousGraphemeBoundary,
} from "./terminal-text.js";

export interface PasteStore {
  counter: number;
  imageCounter?: number;
  entries: Record<string, string>;
}

const MARKER = /\[paste #\d+ (?:\+\d+ lines|\d+ chars)\]|\[Image #\d+\]/g;

export function collapsePaste(
  text: string,
  store?: PasteStore,
): { text: string; store?: PasteStore } {
  const lineCount = text.split("\n").length;
  if (lineCount <= 10 && text.length <= 1000) {
    return { text, store };
  }
  const counter = (store?.counter ?? 0) + 1;
  const detail =
    lineCount > 10
      ? `+${String(lineCount)} lines`
      : `${String(text.length)} chars`;
  const marker = `[paste #${String(counter)} ${detail}]`;
  return {
    text: marker,
    store: {
      ...store,
      counter,
      entries: { ...store?.entries, [marker]: text },
    },
  };
}

export function collapseImage(
  reference: string,
  store?: PasteStore,
): { text: string; store: PasteStore } {
  const imageCounter = (store?.imageCounter ?? 0) + 1;
  const marker = `[Image #${String(imageCounter)}]`;
  return {
    text: marker,
    store: {
      counter: store?.counter ?? 0,
      imageCounter,
      entries: { ...store?.entries, [marker]: reference },
    },
  };
}

export function expandPastes(text: string, store?: PasteStore): string {
  // One pass: marker-like text inside pasted content is literal, never expanded again.
  return store
    ? text.replace(MARKER, (marker: string, offset: number, source: string) => {
        const content = store.entries[marker];
        if (content === undefined || !marker.startsWith("[Image #")) {
          return content ?? marker;
        }
        // Editing adjacent text must not turn a real attachment into an unrecognized @mention.
        const before = offset > 0 && !/\s/.test(source[offset - 1]) ? " " : "";
        const end = offset + marker.length;
        const after = end < source.length && !/\s/.test(source[end]) ? " " : "";
        return before + content + after;
      })
    : text;
}

export function inputBoundary(
  text: string,
  index: number,
  direction: "previous" | "next" | "clamp",
  store?: PasteStore,
): number {
  if (store) {
    for (const match of text.matchAll(MARKER)) {
      if (store.entries[match[0]] === undefined) {
        continue;
      }
      const start = match.index;
      const end = start + match[0].length;
      if (direction === "next" && start <= index && index < end) {
        return end;
      }
      if (
        start < index &&
        (index < end || (direction === "previous" && index === end))
      ) {
        return start;
      }
    }
  }
  return direction === "next"
    ? nextGraphemeBoundary(text, index)
    : direction === "previous"
      ? previousGraphemeBoundary(text, index)
      : clampToGraphemeBoundary(text, index);
}
