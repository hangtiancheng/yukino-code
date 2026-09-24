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

import { Box, Text, useBoxMetrics, useStdout, type DOMElement } from "ink";
import { useLayoutEffect, useRef } from "react";

import { truncateToWidth, visibleWidth, wrapToLines } from "./terminal-text.js";

import type { ThinkingLevel } from "@/config/index.js";
import { THEME, thinkingLevelColor } from "@/ui/styles.js";
import { compactPath } from "@/utils/paths.js";

interface FooterProps {
  /** Current context occupancy in tokens (not the cumulative session total). */
  contextTokens: number;
  contextWindow: number;
  inputTokens: number;
  model: string;
  outputTokens: number;
  onHeightChange?: (height: number) => void;
  permissionMode: string;
  provider: string;
  sessionId: string;
  thinkingLevel?: ThinkingLevel;
  workDir: string;
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

function locationLines(
  workDir: string,
  sessionId: string,
  width: number,
): string[] {
  const path = compactPath(workDir);
  if (!sessionId) {
    return [truncateToWidth(path, width)];
  }
  const pathWidth = width - visibleWidth(sessionId) - 3;
  if (pathWidth >= 1) {
    const cwd = truncateToWidth(path, pathWidth);
    return [
      `${cwd}${" ".repeat(pathWidth - visibleWidth(cwd))} · ${sessionId}`,
    ];
  }
  // Session IDs are copyable identifiers, never ellipsize them to make room
  // for a path. On very small terminals they get their own wrapped rows.
  return [truncateToWidth(path, width), ...wrapToLines(sessionId, width)];
}

export function Footer(props: FooterProps) {
  const {
    contextTokens,
    contextWindow,
    inputTokens,
    model,
    outputTokens,
    permissionMode,
    provider,
    sessionId,
    thinkingLevel,
    workDir,
  } = props;
  const { stdout } = useStdout();
  const ref = useRef<DOMElement>(null);
  const { height, hasMeasured } = useBoxMetrics(ref);
  useLayoutEffect(() => {
    if (hasMeasured) {
      props.onHeightChange?.(height);
    }
  }, [hasMeasured, height, props.onHeightChange]);
  const columns = Math.max(1, stdout.columns || 80);
  const padding = columns > 2 ? 1 : 0;
  const width = columns - padding * 2;
  // Context occupancy, not the cumulative session total: the latter grows
  // unboundedly across turns and would report well over 100%.
  const percentage =
    contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;
  const contextColor =
    percentage >= 90
      ? THEME.error
      : percentage >= 70
        ? THEME.warning
        : THEME.dim;
  const tokens = `↑${formatTokens(inputTokens)} ↓${formatTokens(outputTokens)}`;
  const context = `${percentage.toFixed(1)}%/${formatTokens(contextWindow)}`;
  const statsWidth = visibleWidth(`${tokens} ${context}`);
  const mode = MODE_DISPLAY[permissionMode] ?? permissionMode;
  const rightWidth = width - statsWidth - 2;
  const thinkingSuffix = thinkingLevel ? ` · ${thinkingLevel}` : "";
  const minimumIdentityWidth = (model ? 2 : 0) + visibleWidth(thinkingSuffix);
  const separateIdentity =
    rightWidth < visibleWidth(mode) + 3 + minimumIdentityWidth;
  const identityWidth = separateIdentity
    ? width
    : rightWidth - visibleWidth(mode) - 3;
  const modelWidth = Math.max(0, identityWidth - visibleWidth(thinkingSuffix));
  const fullIdentity = provider ? `${provider}/${model}` : model;
  // Keep the model and complete thinking level before provider names or shortcuts.
  const identity =
    visibleWidth(fullIdentity) <= modelWidth
      ? fullIdentity
      : truncateToWidth(model, modelWidth);
  const separateThinking = thinkingLevel !== undefined && modelWidth < 2;
  const cycleHint = "  Shift+Tab to cycle";
  const hint =
    !separateIdentity &&
    visibleWidth(`${fullIdentity}${thinkingSuffix} · ${mode}${cycleHint}`) <=
      rightWidth
      ? cycleHint
      : "";
  const gap = Math.max(
    2,
    width -
      statsWidth -
      visibleWidth(`${identity}${thinkingSuffix} · ${mode}${hint}`),
  );
  const thinking = thinkingLevel ? (
    <Text color={thinkingLevelColor(thinkingLevel)}>
      {wrapToLines(thinkingLevel, width).join("\n")}
    </Text>
  ) : null;
  const modelIdentity = (
    <Text color={THEME.muted}>
      {separateThinking ? truncateToWidth(model, width) : identity}
      {thinking ? (separateThinking ? "\n" : " · ") : ""}
      {thinking}
    </Text>
  );
  const stats = (
    <Text color={THEME.dim}>
      {tokens} <Text color={contextColor}>{context}</Text>
    </Text>
  );
  const summary =
    statsWidth + 2 + visibleWidth(mode) <= width ? (
      stats
    ) : (
      <Text color={contextColor}>{wrapToLines(context, width).join("\n")}</Text>
    );
  const modeLabel = (
    <Text color={permissionModeColor(permissionMode)}>
      {wrapToLines(mode, width)
        .map((line) => truncateToWidth(line, width))
        .join("\n")}
    </Text>
  );

  return (
    <Box
      ref={ref}
      flexDirection="column"
      width={columns}
      paddingLeft={padding}
      paddingRight={padding}
    >
      <Text color={THEME.dim}>
        {locationLines(workDir, sessionId, width).join("\n")}
      </Text>
      {separateIdentity ? (
        <>
          {visibleWidth(context) + 2 + visibleWidth(mode) <= width ? (
            <Text color={THEME.dim}>
              {summary} {modeLabel}
            </Text>
          ) : (
            <>
              {modeLabel}
              {summary}
            </>
          )}
          {modelIdentity}
        </>
      ) : (
        <Text color={THEME.dim}>
          {stats}
          {" ".repeat(gap)}
          {modelIdentity} · {modeLabel}
          {hint}
        </Text>
      )}
    </Box>
  );
}
