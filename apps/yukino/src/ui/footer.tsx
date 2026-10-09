import chalk from "chalk";
import { Box, Text } from "ink";

import {
  plainTerminalLine,
  truncateToWidth,
  visibleWidth,
} from "./terminal-text.js";
import {
  useAvailableRows,
  useTerminalDimensions,
} from "./use-terminal-layout.js";

import type { ThinkingLevel } from "@/config/provider-config.js";
import { THEME, thinkingLevelColor } from "@/ui/styles.js";
import { compactPath } from "@/utils/paths.js";

interface FooterProps {
  contextTokens: number;
  contextWindow: number;
  inputTokens: number;
  model: string;
  outputTokens: number;
  permissionMode: string;
  provider: string;
  sessionId: string;
  thinkingLevel?: ThinkingLevel;
  cwd: string;
}

const MODE_DISPLAY: Record<string, string> = {
  default: "Default",
  acceptEdits: "Accept Edits",
  plan: "Plan",
  bypassPermissions: "YOLO",
};

function permissionModeColor(mode: string): string {
  if (mode === "acceptEdits") {
    return THEME.success;
  }
  if (mode === "plan") {
    return THEME.warning;
  }
  if (mode === "bypassPermissions") {
    return THEME.error;
  }
  return THEME.dim;
}

function formatTokens(value: number): string {
  if (value < 1000) {
    return String(value);
  }
  if (value < 1_000_000) {
    return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  }
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function locationLine(cwd: string, sessionId: string, width: number): string {
  const path = compactPath(cwd);
  const id =
    visibleWidth(sessionId) + 7 <= width ? sessionId : sessionId.slice(0, 8);
  const pathWidth = width - visibleWidth(id) - 3;
  if (!id || pathWidth < 4) {
    return truncateToWidth(path, width);
  }
  const displayPath = truncateToWidth(path, pathWidth);
  return `${displayPath}${" ".repeat(pathWidth - visibleWidth(displayPath))} · ${id}`;
}

export function Footer(props: FooterProps) {
  const { columns } = useTerminalDimensions();
  const rowBudget = Math.min(3, useAvailableRows());
  const padding = columns > 2 ? 1 : 0;
  const width = columns - padding * 2;
  const model = plainTerminalLine(props.model);
  const provider = plainTerminalLine(props.provider);
  const mode = plainTerminalLine(
    MODE_DISPLAY[props.permissionMode] ?? props.permissionMode,
  );
  const percentage =
    props.contextWindow > 0
      ? (props.contextTokens / props.contextWindow) * 100
      : 0;
  const contextColor =
    percentage >= 90
      ? THEME.error
      : percentage >= 70
        ? THEME.warning
        : THEME.dim;
  const tokens = `↑${formatTokens(props.inputTokens)} ↓${formatTokens(props.outputTokens)}`;
  const context = chalk.hex(contextColor)(
    `${percentage.toFixed(1)}%/${formatTokens(props.contextWindow)}`,
  );
  const stats = `${chalk.hex(THEME.dim)(tokens)} ${context}`;
  const modeLabel = chalk.hex(permissionModeColor(props.permissionMode))(mode);
  const thinking = props.thinkingLevel
    ? ` · ${chalk.hex(thinkingLevelColor(props.thinkingLevel))(props.thinkingLevel)}`
    : "";
  const fullModel = provider ? `${provider}/${model}` : model;
  const rightWidth = width - visibleWidth(stats) - 2;
  const separate = rightWidth < visibleWidth(mode) + visibleWidth(thinking) + 5;
  const identityWidth = separate ? width : rightWidth - visibleWidth(mode) - 3;
  const modelWidth = Math.max(1, identityWidth - visibleWidth(thinking));
  const identity = `${chalk.hex(THEME.muted)(visibleWidth(fullModel) <= modelWidth ? fullModel : truncateToWidth(model, modelWidth))}${thinking}`;
  const location = chalk.hex(THEME.dim)(
    locationLine(
      plainTerminalLine(props.cwd),
      plainTerminalLine(props.sessionId),
      width,
    ),
  );
  const hint = "  Shift+Tab to cycle";
  const right = `${identity} · ${modeLabel}`;
  let lines: string[];

  if (rowBudget === 1) {
    lines = [`${modeLabel} · ${identity}`];
  } else if (separate) {
    const summary = visibleWidth(`${stats} ${mode}`) <= width ? stats : context;
    const separateMode = visibleWidth(`${mode} ${summary}`) > width;
    lines = separateMode
      ? [identity, modeLabel, context]
      : [identity, `${modeLabel} ${summary}`];
    if (rowBudget >= 3 && !separateMode) {
      lines.unshift(location);
    }
  } else {
    const suffix =
      visibleWidth(`${stats}  ${right}${hint}`) <= width ? hint : "";
    const gap = Math.max(
      2,
      width - visibleWidth(stats) - visibleWidth(right) - visibleWidth(suffix),
    );
    lines = [location, `${stats}${" ".repeat(gap)}${right}${suffix}`];
  }

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      width={columns}
      paddingX={padding}
      display={rowBudget > 0 ? "flex" : "none"}
    >
      <Text>
        {lines
          .slice(0, rowBudget)
          .map((line) => truncateToWidth(line, width))
          .join("\n")}
      </Text>
    </Box>
  );
}
