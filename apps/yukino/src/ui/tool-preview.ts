import { Chalk } from "chalk";

import { wrapToLines } from "./terminal-text.js";

import { isDiffTool } from "@/tools/is-diff-tool.js";
import { THEME } from "@/ui/styles.js";

const colors = new Chalk({ level: 3 });

export function formatToolOutputPreview(
  toolName: string,
  text: string,
  width = 80,
): string {
  const normalized = text.trimEnd();
  const styled = isDiffTool(toolName)
    ? normalized
        .split("\n")
        .map((line) =>
          colors.hex(
            line.startsWith("+ ")
              ? THEME.toolDiffAdded
              : line.startsWith("- ")
                ? THEME.toolDiffRemoved
                : THEME.toolDiffContext,
          )(line),
        )
        .join("\n")
    : normalized;
  const lines = wrapToLines(styled, width);
  const lowerName = toolName.toLowerCase();
  const limit = lowerName.includes("grep")
    ? 15
    : lowerName.includes("glob") ||
        lowerName.includes("find") ||
        lowerName.includes("list")
      ? 20
      : lowerName.includes("bash") || lowerName.includes("powershell")
        ? 5
        : 10;
  if (lines.length <= limit) {
    return lines.join("\n");
  }
  const visible =
    lowerName.includes("bash") || lowerName.includes("powershell")
      ? lines.slice(-limit)
      : lines.slice(0, limit);
  return `${visible.join("\n")}\n… (${String(lines.length - limit)} more lines, Ctrl+O to expand)`;
}
