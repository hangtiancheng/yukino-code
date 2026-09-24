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

import { Box, Text, useStdout } from "ink";

import { DiffLines } from "./diff-render.js";
import {
  expandTabs,
  truncateToWidth,
  visibleWidth,
  wrapToLines,
} from "./terminal-text.js";
import { formatToolOutputPreview } from "./tool-preview.js";

import { isDiffTool } from "@/tools/is-diff-tool.js";
import { THEME } from "@/ui/styles.js";
import { formatToolArgs } from "@/utils/index.js";

export type ToolCardStatus = "running" | "completed" | "failed" | "stopped";

export interface ToolBlockInfo {
  toolId: string;
  toolName: string;
  args: Record<string, unknown>;
  output?: string;
  progress?: string;
  status?: ToolCardStatus;
  isError?: boolean;
  elapsed?: number;
  loading?: boolean;
}

interface ToolCardProps {
  toolName: string;
  argsSummary: string;
  output?: string;
  progress?: string;
  status?: ToolCardStatus;
  isError?: boolean;
  elapsed?: number;
  loading?: boolean;
  expanded?: boolean;
}

export function ToolCard({
  toolName,
  argsSummary,
  output,
  progress,
  status,
  isError,
  elapsed,
  loading,
  expanded = false,
}: ToolCardProps) {
  const { stdout } = useStdout();
  const width = Math.max(1, stdout.columns || 80);
  const padding = width > 2 ? 1 : 0;
  const contentWidth = width - padding * 2;
  const resolvedStatus =
    status ?? (loading ? "running" : isError ? "failed" : undefined);
  const backgroundColor =
    resolvedStatus === "running"
      ? THEME.toolPendingBg
      : resolvedStatus === "failed" || resolvedStatus === "stopped"
        ? THEME.toolErrorBg
        : THEME.toolSuccessBg;
  const shell = /^(bash|powershell)$/iu.test(toolName);
  const title = (
    shell
      ? `${toolName.toLowerCase() === "bash" ? "$" : ">"} ${argsSummary}`
      : `${toolName}${argsSummary ? ` ${argsSummary}` : ""}`
  ).replace(/[\r\n\t]+/g, " ");
  const statusLabel = resolvedStatus ?? "";
  const timing =
    elapsed !== undefined && elapsed > 0 ? `${elapsed.toFixed(1)}s` : "";
  const metadata = [statusLabel, timing].filter(Boolean).join(" · ");
  const inlineMetadata = metadata && contentWidth >= visibleWidth(metadata) + 4;
  const titleWidth = inlineMetadata
    ? contentWidth - visibleWidth(metadata) - 2
    : contentWidth;
  const preview = output
    ? expanded
      ? expandTabs(output.trimEnd())
      : formatToolOutputPreview(toolName, output, contentWidth)
    : "";
  // A wide grapheme cannot fit in a one-column terminal, even with hard wrapping.
  const shown =
    contentWidth === 1
      ? wrapToLines(preview, contentWidth)
          .map((line) => truncateToWidth(line, contentWidth))
          .join("\n")
      : preview;
  const metadataDetail = (
    <Text
      color={
        resolvedStatus === "failed" || resolvedStatus === "stopped"
          ? THEME.error
          : THEME.dim
      }
    >
      {wrapToLines(metadata, contentWidth).join("\n")}
    </Text>
  );

  return (
    <Box
      backgroundColor={backgroundColor}
      flexDirection="column"
      marginTop={1}
      paddingX={padding}
      paddingY={1}
      width={width}
    >
      <Text wrap="truncate-end">
        <Text bold color={THEME.toolTitle}>
          {truncateToWidth(title, titleWidth)}
        </Text>
        {inlineMetadata ? "  " : ""}
        {inlineMetadata ? metadataDetail : null}
      </Text>
      {metadata && !inlineMetadata ? metadataDetail : null}
      {progress ? (
        <Text color={THEME.toolOutput}>
          {wrapToLines(progress, contentWidth).join("\n")}
        </Text>
      ) : null}
      {shown ? (
        isDiffTool(toolName) ? (
          <DiffLines text={shown} />
        ) : (
          <Text color={THEME.toolOutput}>{shown}</Text>
        )
      ) : null}
    </Box>
  );
}

export function ToolBlock({
  tool,
  expanded = false,
}: {
  tool: ToolBlockInfo;
  expanded?: boolean;
}) {
  return (
    <ToolCard
      {...tool}
      argsSummary={formatToolArgs(tool.args)}
      expanded={expanded}
    />
  );
}

export function ToolDisplay({
  tools,
  expanded = false,
}: {
  tools: ToolBlockInfo[];
  expanded?: boolean;
}) {
  return (
    <Box flexDirection="column">
      {tools.map((tool) => (
        <ToolBlock key={tool.toolId} tool={tool} expanded={expanded} />
      ))}
    </Box>
  );
}
