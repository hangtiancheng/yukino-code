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

import { Box, Text, useWindowSize } from "ink";
import type { ReactNode } from "react";

import { truncateToWidth, visibleWidth } from "./terminal-text.js";

import { THEME } from "@/ui/styles.js";

function fitHint(hint: string, width: number): string {
  const full = hint.replace(/[\r\n\t]+/g, " ");
  const compact = full.replace(/Escape/g, "Esc").replace(/ navigate/g, "");
  const actions = compact.split(" · ").filter((part) => /Enter|Esc/.test(part));
  const keys = actions.map((part) => part.split(" ")[0]).join(" / ");
  return truncateToWidth(
    [full, compact, actions.join(" · "), keys].find(
      (text) => text && visibleWidth(text) <= width,
    ) ??
      (keys || compact),
    width,
  );
}

interface SelectorFrameProps {
  children: ReactNode;
  compact?: boolean;
  hint: string;
  subtitle?: string;
  title: string;
  width?: number;
}

export function SelectorFrame({
  children,
  compact = false,
  hint,
  subtitle,
  title,
  width,
}: SelectorFrameProps) {
  const { columns } = useWindowSize();
  const frameWidth = Math.max(1, width ?? columns);
  const padding = frameWidth > 2 ? 1 : 0;
  const contentWidth = frameWidth - padding * 2;
  const rule = "─".repeat(frameWidth);
  const singleLine = (text: string) =>
    truncateToWidth(text.replace(/\s*\n\s*/g, " "), contentWidth);

  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      <Text color={THEME.borderMuted} wrap="truncate-end">
        {rule}
      </Text>
      <Box flexDirection="column" paddingX={padding}>
        <Text bold color={THEME.accent} wrap="truncate-end">
          {singleLine(title)}
        </Text>
        {subtitle ? (
          <Text color={THEME.muted} wrap="truncate-end">
            {singleLine(subtitle)}
          </Text>
        ) : null}
        <Box flexDirection="column" marginTop={compact ? 0 : 1}>
          {children}
        </Box>
        <Text color={THEME.dim} wrap="truncate-end">
          {fitHint(hint, contentWidth)}
        </Text>
      </Box>
      <Text color={THEME.borderMuted} wrap="truncate-end">
        {rule}
      </Text>
    </Box>
  );
}
