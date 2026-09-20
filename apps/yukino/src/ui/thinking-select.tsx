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

import { Box, Text, measureElement, useBoxMetrics, useInput, useWindowSize } from "ink";
import type { DOMElement } from "ink";
import { useLayoutEffect, useRef, useState } from "react";

import { getListWindowStart } from "./list-window.js";
import { SelectorFrame } from "./selector-frame.js";
import { truncateToWidth, visibleWidth } from "./terminal-text.js";

import { THINKING_LEVELS, type ThinkingLevel } from "@/config/index.js";
import { ICONS, THEME, thinkingLevelColor } from "@/ui/styles.js";

interface ThinkingSelectProps {
  currentLevel: ThinkingLevel;
  levels?: readonly ThinkingLevel[];
  onSelect: (level: ThinkingLevel) => void;
  onCancel: () => void;
}

const descriptions: Record<ThinkingLevel, string> = {
  off: "Reasoning off",
  minimal: "Brief reasoning",
  low: "Light reasoning",
  medium: "Balanced reasoning",
  high: "Deep reasoning",
  xhigh: "Extra-deep reasoning",
  max: "Most thorough reasoning",
};

export function ThinkingSelect({
  currentLevel,
  levels = THINKING_LEVELS,
  onSelect,
  onCancel,
}: ThinkingSelectProps) {
  const [focusedLevel, setFocusedLevel] = useState(currentLevel);
  const cursor = Math.max(0, levels.indexOf(focusedLevel));
  const selected = levels.at(cursor);
  const ref = useRef<DOMElement>(null);
  const metrics = useBoxMetrics(ref);
  const { columns, rows } = useWindowSize();
  const [top, setTop] = useState(0);
  useLayoutEffect(() => {
    if (ref.current) {
      setTop(measureElement(ref.current).y);
    }
  });
  const width = Math.max(1, metrics.hasMeasured ? metrics.width : columns);
  const contentWidth = width - (width > 2 ? 2 : 0);
  const availableRows = Math.max(0, rows - top - 2);
  // Two rules, title, description, and hint; leave the footer outside the frame.
  const count = Math.max(0, Math.min(levels.length, availableRows - 5));
  const start = getListWindowStart(levels.length, cursor, count);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
    } else if (key.upArrow || key.leftArrow || key.downArrow || key.rightArrow) {
      if (levels.length > 0) {
        const direction = key.upArrow || key.leftArrow ? -1 : 1;
        const next = levels.at((cursor + direction + levels.length) % levels.length);
        if (next) {
          setFocusedLevel(next);
        }
      }
    } else if (key.return && selected) {
      onSelect(selected);
    }
  });

  return (
    <Box ref={ref} flexDirection="column" width="100%" maxHeight={availableRows} overflow="hidden">
      <SelectorFrame
        compact
        title="Thinking level"
        subtitle={selected ? descriptions[selected] : "No levels available"}
        hint="↑↓/←→ navigate · Enter select · Esc cancel"
        width={width}
      >
        {count === 0 && levels.length > 0 ? (
          <Text color={THEME.muted} wrap="truncate-end">
            {truncateToWidth("Terminal too short", contentWidth)}
          </Text>
        ) : (
          levels.slice(start, start + count).map((level, index) => {
            const focused = start + index === cursor;
            const pointer = contentWidth > 2 ? (focused ? `${ICONS.arrow} ` : "  ") : "";
            const marker =
              level === currentLevel && contentWidth >= level.length + 4 ? ` ${ICONS.success}` : "";
            const labelWidth = Math.max(0, contentWidth - visibleWidth(pointer + marker));
            const descriptionWidth = labelWidth - visibleWidth(level) - 2;
            return (
              <Box
                key={level}
                backgroundColor={focused ? THEME.selectedBg : undefined}
                width="100%"
              >
                <Text wrap="truncate-end">
                  <Text color={THEME.accent}>{pointer}</Text>
                  <Text bold={focused} color={thinkingLevelColor(level)}>
                    {truncateToWidth(level, labelWidth)}
                  </Text>
                  <Text color={THEME.success}>{marker}</Text>
                  {descriptionWidth >= 12 ? (
                    <Text color={THEME.muted}>
                      {`  ${truncateToWidth(descriptions[level], descriptionWidth)}`}
                    </Text>
                  ) : null}
                </Text>
              </Box>
            );
          })
        )}
      </SelectorFrame>
    </Box>
  );
}
