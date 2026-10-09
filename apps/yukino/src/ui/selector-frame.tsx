import { Box, Text } from "ink";
import type { DOMElement } from "ink";
import type { ReactNode, RefObject } from "react";

import { selectorChrome } from "./selector-layout.js";
import { ContentViewport } from "./terminal-layout.js";
import {
  plainTerminalLine,
  truncateToWidth,
  visibleWidth,
} from "./terminal-text.js";
import {
  AvailableRows,
  useAvailableRows,
  useTerminalDimensions,
} from "./use-terminal-layout.js";

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
  rows?: number;
  focusRef?: RefObject<DOMElement | null>;
}

export function SelectorFrame({
  children,
  compact = false,
  hint,
  subtitle,
  title,
  width,
  rows: requestedRows,
  focusRef,
}: SelectorFrameProps) {
  const { columns } = useTerminalDimensions();
  const availableRows = useAvailableRows();
  const rows = Math.max(0, requestedRows ?? availableRows);
  const chrome = selectorChrome(rows, !!subtitle, compact);
  const frameWidth = Math.max(1, width ?? columns);
  const padding = frameWidth > 2 ? 1 : 0;
  const contentWidth = frameWidth - padding * 2;
  const rule = "─".repeat(frameWidth);
  const singleLine = (text: string) =>
    truncateToWidth(plainTerminalLine(text), contentWidth);

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      width={frameWidth}
      display={rows > 0 ? "flex" : "none"}
    >
      {chrome.borders && (
        <Text color={THEME.borderMuted} wrap="truncate-end">
          {rule}
        </Text>
      )}
      <Box flexDirection="column" paddingX={padding}>
        {chrome.title && (
          <Text bold color={THEME.accent} wrap="truncate-end">
            {singleLine(title)}
          </Text>
        )}
        {chrome.detail && subtitle ? (
          <Text color={THEME.muted} wrap="truncate-end">
            {singleLine(subtitle)}
          </Text>
        ) : null}
        <Box flexDirection="column" marginTop={chrome.gap ? 1 : 0}>
          <AvailableRows value={Math.max(0, rows - chrome.height)}>
            <ContentViewport rows={rows - chrome.height} focusRef={focusRef}>
              {children}
            </ContentViewport>
          </AvailableRows>
        </Box>
        {chrome.hint && (
          <Text color={THEME.dim} wrap="truncate-end">
            {fitHint(hint, contentWidth)}
          </Text>
        )}
      </Box>
      {chrome.borders && (
        <Text color={THEME.borderMuted} wrap="truncate-end">
          {rule}
        </Text>
      )}
    </Box>
  );
}
