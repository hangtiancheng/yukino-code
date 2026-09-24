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

import { Chalk } from "chalk";

import { wrapToLines } from "./terminal-text.js";

import { isDiffTool } from "@/tools/is-diff-tool.js";
import { THEME } from "@/ui/styles.js";

const colors = new Chalk({ level: 3 });

export function formatToolOutputPreview(
  toolName: string,
  text: string,
  width = 80,
): string {
  const normalized = text.trimEnd();
  const styled = isDiffTool(toolName)
    ? normalized
        .split("\n")
        .map((line) =>
          colors.hex(
            line.startsWith("+ ")
              ? THEME.toolDiffAdded
              : line.startsWith("- ")
                ? THEME.toolDiffRemoved
                : THEME.toolDiffContext,
          )(line),
        )
        .join("\n")
    : normalized;
  const lines = wrapToLines(styled, width);
  const lowerName = toolName.toLowerCase();
  const limit = lowerName.includes("grep")
    ? 15
    : lowerName.includes("glob") ||
        lowerName.includes("find") ||
        lowerName.includes("list")
      ? 20
      : lowerName.includes("bash") || lowerName.includes("powershell")
        ? 5
        : 10;
  if (lines.length <= limit) {
    return lines.join("\n");
  }
  const visible =
    lowerName.includes("bash") || lowerName.includes("powershell")
      ? lines.slice(-limit)
      : lines.slice(0, limit);
  return `${visible.join("\n")}\n… (${String(lines.length - limit)} more lines, Ctrl+O to expand)`;
}
