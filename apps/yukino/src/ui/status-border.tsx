import { Text } from "ink";

import { truncateToWidth, visibleWidth } from "./terminal-text.js";

import { THEME } from "@/ui/styles.js";

interface StatusBorderProps {
  width: number;
  color?: string;
  statusLabel?: string;
  spinner?: string;
  hiddenLineCount?: number;
  direction?: "up" | "down";
}

export function StatusBorder({
  width,
  color = THEME.borderMuted,
  statusLabel,
  spinner = "⠋",
  hiddenLineCount = 0,
  direction = "up",
}: StatusBorderProps) {
  const columns = Math.max(0, Math.floor(width));
  const overflow =
    hiddenLineCount > 0
      ? ` ${direction === "up" ? "↑" : "↓"} ${String(hiddenLineCount)} more `
      : "";
  const overflowWidth = visibleWidth(overflow);
  const overflowStart = Math.floor((columns - overflowWidth) / 2);
  let status = statusLabel
    ? truncateToWidth(
        `${spinner} ${statusLabel.replace(/[\r\n\t]+/g, " ")}`,
        Math.max(0, columns - 5),
      )
    : "";
  if (statusLabel && columns < 6) {
    status = spinner;
  }
  const canFitOverflow = () =>
    overflowWidth > 0 &&
    overflowWidth + 2 <= columns &&
    (!status || overflowStart - (4 + visibleWidth(status)) >= 1);

  if (status && overflow && !canFitOverflow()) {
    status = spinner;
  }

  let border: string;
  if (canFitOverflow()) {
    const left = status ? `── ${status} ` : "";
    border =
      left +
      "─".repeat(overflowStart - visibleWidth(left)) +
      overflow +
      "─".repeat(columns - overflowStart - overflowWidth);
  } else if (status && columns >= visibleWidth(status) + 5) {
    border = `── ${status} ${"─".repeat(columns - visibleWidth(status) - 4)}`;
  } else if (status) {
    const compact = truncateToWidth(spinner, columns, "");
    const prefixWidth = Math.min(
      3,
      Math.max(0, columns - visibleWidth(compact)),
    );
    border =
      "─".repeat(prefixWidth) +
      compact +
      "─".repeat(Math.max(0, columns - prefixWidth - visibleWidth(compact)));
  } else {
    border = "─".repeat(columns);
  }

  return <Text color={color}>{border}</Text>;
}
