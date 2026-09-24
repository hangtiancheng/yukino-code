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

import { Box, Text, useStdout } from "ink";

import { renderMarkdown } from "./markdown.js";
import { truncateToWidth, visibleWidth, wrapToLines } from "./terminal-text.js";

import { THEME } from "@/ui/styles.js";

interface Props {
  text: string;
  duration?: number;
  expanded: boolean;
  streaming?: boolean;
}

export function ThinkingBlock({
  text,
  duration,
  expanded,
  streaming = false,
}: Props) {
  const { stdout } = useStdout();
  if (!text.trim() && !duration) {
    return null;
  }
  const columns = Math.max(1, stdout.columns || 80);
  const padding = columns > 2 ? 1 : 0;
  const width = columns - padding * 2;
  const label = duration
    ? `Thinking ${duration.toFixed(1)}s`
    : streaming
      ? "Thinking…"
      : "Thinking";
  const collapsed =
    [
      `${label} · Ctrl+O details`,
      `${label} · Ctrl+O`,
      "Thinking · Ctrl+O",
    ].find((candidate) => visibleWidth(candidate) <= width) ??
    `${truncateToWidth(label, width)}\nCtrl+O`;
  let content = wrapToLines(
    expanded && text.trim()
      ? renderMarkdown(text.trim(), width, "thinking")
      : collapsed,
    width,
  )
    .map((line) => truncateToWidth(line, width))
    .join("\n");
  if (streaming && expanded) {
    const lines = wrapToLines(content, width);
    const limit = Math.max(1, Math.floor((stdout.rows || 24) / 4));
    if (lines.length > limit) {
      content =
        limit === 1 ? "…" : ["…", ...lines.slice(-(limit - 1))].join("\n");
    }
  }
  return (
    <Box width={columns} paddingX={padding} marginTop={1}>
      <Text color={THEME.thinkingText} italic>
        {content}
      </Text>
    </Box>
  );
}
