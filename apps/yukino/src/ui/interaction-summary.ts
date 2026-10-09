import { Chalk } from "chalk";

import { renderMarkdown } from "./markdown.js";
import { THEME } from "./styles.js";
import { plainTerminalText, wrapWordsToLines } from "./terminal-text.js";

import {
  formatInteractionSummary,
  type InteractionSummary,
} from "@/bootstrap/interaction-summary.js";

interface SummaryOptions {
  columns?: number;
  color?: boolean;
  endedAt?: number;
}

export function renderInteractionSummary(
  summary: InteractionSummary,
  {
    columns = process.stdout.columns || 80,
    color = process.stdout.isTTY,
    endedAt = Date.now(),
  }: SummaryOptions = {},
): string {
  const width = Math.max(1, Math.floor(columns));
  const padding = width > 2 ? 1 : 0;
  const contentWidth = width - padding * 2;
  const colors = new Chalk({ level: color ? 3 : 0 });
  const rule = colors.hex(THEME.borderMuted)("─".repeat(width));
  const body = renderMarkdown(
    formatInteractionSummary(summary, endedAt),
    contentWidth,
  );
  const lines = body
    .split("\n")
    .map((line) => (line ? " ".repeat(padding) + line : ""));
  const noticeLines = summary.latestVersion
    ? wrapWordsToLines(
        colors.hex(THEME.warning)(
          `New Yukino version v${summary.latestVersion} is available. Run `,
        ) + colors.bold.hex(THEME.accent)("yukino update"),
        contentWidth,
      ).map((line) => " ".repeat(padding) + line)
    : [];
  const output = [rule, ...lines, rule, ...noticeLines].join("\n");
  return color ? output : plainTerminalText(output);
}
