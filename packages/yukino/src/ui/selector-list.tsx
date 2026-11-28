import { Box, Text, measureElement, useBoxMetrics } from "ink";
import type { DOMElement } from "ink";
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { ICONS, TERMINAL_TOO_SHORT, THEME } from "@/ui/constants.js";
import { CursorText } from "@/ui/cursor-text.js";
import { getListWindowStart } from "@/ui/list-window.js";
import { SelectorFrame } from "@/ui/selector-frame.js";
import { selectorChrome } from "@/ui/selector-layout.js";
import { cursorWindow } from "@/ui/terminal-text.js";
import {
  plainTerminalLine,
  truncateToWidth,
  visibleWidth,
} from "@/ui/terminal-text.js";
import {
  useAvailableRows,
  useTerminalDimensions,
} from "@/ui/use-terminal-layout.js";

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
  searchActive?: boolean;
  queryLabel?: string;
  queryPlaceholder?: string;
  subtitle?: string;
  help?: readonly string[];
  error?: string;
}

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
  searchActive = true,
  queryLabel = "Search: ",
  queryPlaceholder = "type to filter",
  subtitle,
  help = [],
  error,
}: SelectorListProps) {
  const ref = useRef<DOMElement>(null);
  const metrics = useBoxMetrics(ref);
  const { columns } = useTerminalDimensions();
  const [top, setTop] = useState(0);
  useLayoutEffect(() => {
    if (ref.current) {
      setTop(measureElement(ref.current).y);
    }
  });

  const width = Math.max(1, metrics.hasMeasured ? metrics.width : columns);
  const contentWidth = width - (width > 2 ? 2 : 0);
  const availableRows = useAvailableRows(reservedRows, top);
  const frameSubtitle = width >= 60 ? subtitle : undefined;
  const chrome = selectorChrome(availableRows, !!frameSubtitle);
  const contentRows = Math.max(0, availableRows - chrome.height);
  const helpRows = help.slice(0, Math.max(0, contentRows - 4));
  const listRows = Math.max(
    0,
    contentRows - 1 - helpRows.length - Number(!!error),
  );
  const visibleCount = Math.min(10, Math.floor(listRows / itemHeight));
  const windowStart = getListWindowStart(itemCount, cursor, visibleCount);
  const position = `${String(itemCount ? cursor + 1 : 0)}/${String(itemCount)}`;
  const status = query.trim()
    ? `${position} · ${String(totalCount)} total`
    : position;
  const searchWidth = Math.max(0, contentWidth - visibleWidth(status) - 1);
  const searchPrefix = searchWidth >= 9 ? queryLabel : "";
  const search = cursorWindow(
    query,
    query.length,
    Math.max(1, searchWidth - visibleWidth(searchPrefix)),
  );

  return (
    <Box
      ref={ref}
      flexDirection="column"
      maxHeight={availableRows}
      overflow="hidden"
      width="100%"
    >
      <SelectorFrame
        hint={hint}
        title={title}
        subtitle={frameSubtitle}
        width={width}
        rows={availableRows}
      >
        {error ? (
          <Text color={THEME.error} wrap="truncate-end">
            {truncateToWidth(plainTerminalLine(error), contentWidth)}
          </Text>
        ) : null}
        {helpRows.map((line) => (
          <Text key={line} color={THEME.muted} wrap="truncate-end">
            {truncateToWidth(line, contentWidth)}
          </Text>
        ))}
        <Box width="100%">
          <Box flexGrow={1} minWidth={0}>
            {searchWidth > 0 ? (
              <CursorText
                active={searchActive}
                before={`${searchPrefix}${search.leadingEllipsis ? "…" : ""}${search.before}`}
                current={
                  query
                    ? search.current
                    : searchPrefix
                      ? queryPlaceholder[0]
                      : " "
                }
                after={
                  query
                    ? search.after + (search.trailingEllipsis ? "…" : "")
                    : searchPrefix
                      ? truncateToWidth(
                          queryPlaceholder.slice(1),
                          searchWidth - visibleWidth(searchPrefix) - 1,
                        )
                      : ""
                }
                color={query ? THEME.text : THEME.dim}
              />
            ) : (
              <Text color={THEME.dim}>
                {truncateToWidth(query, searchWidth)}
              </Text>
            )}
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
            {truncateToWidth(TERMINAL_TOO_SHORT, contentWidth)}
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
  const singleLineLabel = plainTerminalLine(label);
  const remainingWidth = labelWidth - visibleWidth(singleLineLabel) - 2;
  // Preserve the name and current marker before spending columns on metadata.
  const descriptionText =
    description && remainingWidth >= 12
      ? `  ${truncateToWidth(plainTerminalLine(description), remainingWidth)}`
      : "";

  return (
    <Box
      backgroundColor={focused ? THEME.selectedBg : undefined}
      flexDirection="column"
      paddingX={padding}
      width="100%"
    >
      <Text wrap="truncate-end">
        <Text bold={focused} color={focused ? THEME.accent : THEME.text}>
          {pointer}
          {truncateToWidth(singleLineLabel, labelWidth)}
        </Text>
        <Text color={THEME.success}>{marker}</Text>
        <Text color={THEME.muted}>{descriptionText}</Text>
      </Text>
      {detail !== undefined ? (
        <Text color={THEME.dim} wrap="truncate-end">
          {truncateToWidth(`  ${plainTerminalLine(detail)}`, rowWidth)}
        </Text>
      ) : null}
    </Box>
  );
}
