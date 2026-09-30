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
