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

import { Text } from "ink";

import { truncateToWidth, visibleWidth } from "./terminal-text.js";

import { THEME } from "@/ui/styles.js";

interface StatusBorderProps {
  width: number;
  color?: string;
  statusLabel?: string;
  spinner?: string;
  hiddenLineCount?: number;
  direction?: "up" | "down";
}

export function StatusBorder({
  width,
  color = THEME.borderMuted,
  statusLabel,
  spinner = "⠋",
  hiddenLineCount = 0,
  direction = "up",
}: StatusBorderProps) {
  const columns = Math.max(0, Math.floor(width));
  const overflow =
    hiddenLineCount > 0
      ? ` ${direction === "up" ? "↑" : "↓"} ${String(hiddenLineCount)} more `
      : "";
  const overflowWidth = visibleWidth(overflow);
  const overflowStart = Math.floor((columns - overflowWidth) / 2);
  let status = statusLabel
    ? truncateToWidth(
        `${spinner} ${statusLabel.replace(/[\r\n\t]+/g, " ")}`,
        Math.max(0, columns - 5),
      )
    : "";
  if (statusLabel && columns < 6) {
    status = spinner;
  }
  const canFitOverflow = () =>
    overflowWidth > 0 &&
    overflowWidth + 2 <= columns &&
    (!status || overflowStart - (4 + visibleWidth(status)) >= 1);

  if (status && overflow && !canFitOverflow()) {
    status = spinner;
  }

  let border: string;
  if (canFitOverflow()) {
    const left = status ? `── ${status} ` : "";
    border =
      left +
      "─".repeat(overflowStart - visibleWidth(left)) +
      overflow +
      "─".repeat(columns - overflowStart - overflowWidth);
  } else if (status && columns >= visibleWidth(status) + 5) {
    border = `── ${status} ${"─".repeat(columns - visibleWidth(status) - 4)}`;
  } else if (status) {
    const compact = truncateToWidth(spinner, columns, "");
    const prefixWidth = Math.min(3, Math.max(0, columns - visibleWidth(compact)));
    border =
      "─".repeat(prefixWidth) +
      compact +
      "─".repeat(Math.max(0, columns - prefixWidth - visibleWidth(compact)));
  } else {
    border = "─".repeat(columns);
  }

  return <Text color={color}>{border}</Text>;
}
