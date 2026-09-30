import { Box, Text, measureElement, useBoxMetrics, useWindowSize } from "ink";
import type { DOMElement } from "ink";
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { getListWindowStart } from "./list-window.js";
import { SelectorFrame } from "./selector-frame.js";
import { truncateToWidth, visibleWidth } from "./terminal-text.js";

import { ICONS, THEME } from "@/ui/styles.js";

interface SelectorListProps {
  children: (start: number, count: number, width: number) => ReactNode;
  cursor: number;
  emptyText: string;
  hint: string;
  itemCount: number;
  itemHeight: number;
  query: string;
  title: string;
  totalCount: number;
  reservedRows?: number;
}

// Presentation only: each dialog keeps ownership of its input and selection semantics.
export function SelectorList({
  children,
  cursor,
  emptyText,
  hint,
  itemCount,
  itemHeight,
  query,
  title,
  totalCount,
  reservedRows = 2,
}: SelectorListProps) {
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
  const availableRows = Math.max(0, rows - top - reservedRows);
  // Two rules, title, hint, search, and (when space permits) one blank line.
  const compact = availableRows < 6 + itemHeight;
  const listRows = Math.max(0, availableRows - (compact ? 5 : 6));
  const visibleCount = Math.min(10, Math.floor(listRows / itemHeight));
  const windowStart = getListWindowStart(itemCount, cursor, visibleCount);
  const position = `${String(itemCount ? cursor + 1 : 0)}/${String(itemCount)}`;
  const status = query.trim()
    ? `${position} · ${String(totalCount)} total`
    : position;
  const searchWidth = Math.max(0, contentWidth - visibleWidth(status) - 1);

  return (
    <Box
      ref={ref}
      flexDirection="column"
      maxHeight={availableRows}
      overflow="hidden"
      width="100%"
    >
      <SelectorFrame compact={compact} hint={hint} title={title} width={width}>
        <Box width="100%">
          <Box flexGrow={1} minWidth={0}>
            <Text color={query ? THEME.text : THEME.dim} wrap="truncate-end">
              {truncateToWidth(
                query ? `Search: ${query}` : "Search: type to filter",
                searchWidth,
              )}
            </Text>
          </Box>
          <Text color={THEME.dim} wrap="truncate-end">
            {truncateToWidth(status, contentWidth)}
          </Text>
        </Box>
        {itemCount === 0 ? (
          <Text color={THEME.muted} wrap="truncate-end">
            {truncateToWidth(emptyText, contentWidth)}
          </Text>
        ) : visibleCount === 0 ? (
          <Text color={THEME.muted} wrap="truncate-end">
            {truncateToWidth("Terminal too short", contentWidth)}
          </Text>
        ) : (
          children(windowStart, visibleCount, contentWidth)
        )}
      </SelectorFrame>
    </Box>
  );
}

interface SelectorListRowProps {
  current: boolean;
  description?: string;
  detail?: string;
  focused: boolean;
  label: string;
  width: number;
}

export function SelectorListRow({
  current,
  description,
  detail,
  focused,
  label,
  width,
}: SelectorListRowProps) {
  const padding = width > 4 ? 1 : 0;
  const rowWidth = Math.max(0, width - padding * 2);
  const pointer = focused ? `${ICONS.arrow} ` : "  ";
  const marker = current ? ` ${ICONS.success}` : "";
  const labelWidth = Math.max(
    0,
    rowWidth - visibleWidth(pointer) - visibleWidth(marker),
  );
  const singleLineLabel = label.replace(/[\r\n\t]+/g, " ");
  const remainingWidth = labelWidth - visibleWidth(singleLineLabel) - 2;
  // Preserve the name and current marker before spending columns on metadata.
  const descriptionText =
    description && remainingWidth >= 12
      ? `  ${truncateToWidth(description.replace(/[\r\n\t]+/g, " "), remainingWidth)}`
      : "";

  return (
    <Box
      backgroundColor={focused ? THEME.selectedBg : undefined}
      flexDirection="column"
      paddingX={padding}
      width="100%"
    >
      <Text wrap="truncate-end">
        <Text color={focused ? THEME.accent : THEME.text}>
          {pointer}
          {truncateToWidth(singleLineLabel, labelWidth)}
        </Text>
        <Text color={THEME.success}>{marker}</Text>
        <Text color={THEME.muted}>{descriptionText}</Text>
      </Text>
      {detail !== undefined ? (
        <Text color={THEME.dim} wrap="truncate-end">
          {truncateToWidth(`  ${detail.replace(/[\r\n\t]+/g, " ")}`, rowWidth)}
        </Text>
      ) : null}
    </Box>
  );
}
