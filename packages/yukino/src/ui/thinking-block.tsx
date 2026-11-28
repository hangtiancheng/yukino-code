import { Box, Text } from "ink";

import { THEME } from "@/ui/constants.js";
import { useDisplayPreferences } from "@/ui/display-preferences.js";
import { renderMarkdown } from "@/ui/markdown.js";
import {
  truncateToWidth,
  visibleWidth,
  wrapToLines,
} from "@/ui/terminal-text.js";
import { useTerminalDimensions } from "@/ui/use-terminal-layout.js";

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
  const display = useDisplayPreferences();
  const { columns, rows } = useTerminalDimensions();
  if (!display.show_thinking || (!text.trim() && !duration)) {
    return null;
  }
  const padding = Math.min(
    display.output_padding,
    Math.max(0, Math.floor((columns - 1) / 2)),
  );
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
    const limit = Math.max(1, Math.floor(rows / 4));
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
