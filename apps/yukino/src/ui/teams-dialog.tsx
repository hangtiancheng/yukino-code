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

import { Box, Text, useInput } from "ink";
import { useState } from "react";

import { SelectorFrame } from "./selector-frame.js";

import type { TeammateUIState } from "@/teams/progress.js";
import { formatTokens } from "@/teams/progress.js";
import { THEME } from "@/ui/styles.js";

interface Props {
  teammates: TeammateUIState[];
  onClose: () => void;
  onKill?: (name: string, teamName: string) => void;
  onShutdown?: (name: string, teamName: string) => void;
}

export function TeamsDialog({ teammates, onClose, onKill, onShutdown }: Props) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailName, setDetailName] = useState<string | null>(null);
  const selected =
    teammates[Math.min(selectedIndex, Math.max(0, teammates.length - 1))];
  const detail = detailName
    ? teammates.find((teammate) => teammate.name === detailName)
    : undefined;

  useInput((input, key) => {
    if (detailName) {
      if (key.escape || key.leftArrow) {
        setDetailName(null);
      } else if (detail && input === "k" && onKill) {
        onKill(detail.name, detail.teamName);
      } else if (detail && input === "s" && onShutdown) {
        onShutdown(detail.name, detail.teamName);
      }
      return;
    }

    if (key.escape) {
      onClose();
    } else if (key.upArrow) {
      setSelectedIndex((current) =>
        current > 0 ? current - 1 : teammates.length - 1,
      );
    } else if (key.downArrow) {
      setSelectedIndex((current) =>
        current < teammates.length - 1 ? current + 1 : 0,
      );
    } else if (key.return && selected) {
      setDetailName(selected.name);
    } else if (input === "k" && selected && onKill) {
      onKill(selected.name, selected.teamName);
    } else if (input === "s" && selected && onShutdown) {
      onShutdown(selected.name, selected.teamName);
    }
  });

  if (detail) {
    return <TeamDetail teammate={detail} />;
  }

  return (
    <SelectorFrame
      hint="↑↓ navigate · Enter detail · k kill · s shutdown · Escape close"
      title="Teams"
    >
      {teammates.length === 0 ? (
        <Text color={THEME.muted}>No active teammates</Text>
      ) : null}
      {teammates.map((teammate, _index) => {
        const active = teammate === selected;
        return (
          <Box
            key={`${teammate.teamName}/${teammate.name}`}
            backgroundColor={active ? THEME.selectedBg : undefined}
            paddingLeft={1}
            paddingRight={1}
            width="100%"
          >
            <Text color={active ? THEME.accent : THEME.text}>
              {active ? "› " : "  "}@{teammate.name}
            </Text>
            <Text color={THEME.muted} wrap="truncate-end">
              {` · ${teammate.status} · ${String(teammate.progress.toolUseCount)} tools · ${formatTokens(teammate.progress.tokenCount)} tokens`}
            </Text>
          </Box>
        );
      })}
    </SelectorFrame>
  );
}

function TeamDetail({ teammate }: { teammate: TeammateUIState }) {
  const elapsed = formatElapsed(teammate.startTime);
  const activities = teammate.progress.recentActivities;
  return (
    <SelectorFrame
      hint="←/Escape back · k kill · s shutdown"
      subtitle={`${teammate.status} · ${elapsed} · ${String(teammate.progress.toolUseCount)} tools · ${formatTokens(teammate.progress.tokenCount)} tokens`}
      title={`@${teammate.name}`}
    >
      {activities.length > 0 ? (
        activities.map((activity, index) => (
          <Text
            key={`${String(index)}-${activity.activityDescription}`}
            color={THEME.muted}
          >
            {index === activities.length - 1 ? "└─ " : "├─ "}
            {activity.activityDescription}
          </Text>
        ))
      ) : (
        <Text color={THEME.muted}>No recent activity</Text>
      )}
      {teammate.lastMessage ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={THEME.dim}>Last message</Text>
          <Text color={THEME.text} wrap="truncate-end">
            {teammate.lastMessage}
          </Text>
        </Box>
      ) : null}
    </SelectorFrame>
  );
}

function formatElapsed(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  if (seconds < 60) {
    return `${String(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${String(minutes)}m${String(seconds % 60)}s`;
  }
  return `${String(Math.floor(minutes / 60))}h${String(minutes % 60)}m`;
}
