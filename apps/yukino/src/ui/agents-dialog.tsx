import { Box, Text, useInput } from "ink";
import type { DOMElement } from "ink";
import { useRef, useState } from "react";

import type { SubagentProgress } from "./agent-tool-progress.js";
import { getListWindowStart } from "./list-window.js";
import { SelectorFrame } from "./selector-frame.js";
import { selectorChrome } from "./selector-layout.js";
import { useAvailableRows } from "./use-terminal-layout.js";

import type { AgentTask } from "@/subagent/task-manager.js";
import type { TeammateUIState } from "@/teams/progress.js";
import { formatTokens } from "@/teams/progress.js";
import { toDisplayPreview } from "@/tool-result/index.js";
import { THEME } from "@/ui/styles.js";

interface Props {
  teammates: TeammateUIState[];
  backgroundTasks: AgentTask[];
  subagents: SubagentProgress[];
  onClose: () => void;
  onKill?: (name: string, teamName: string) => void;
  onShutdown?: (name: string, teamName: string) => void;
  onStopBackground?: (taskId: string) => void;
}

export function AgentsDialog({
  teammates,
  backgroundTasks,
  subagents,
  onClose,
  onKill,
  onShutdown,
  onStopBackground,
}: Props) {
  const rows = useAvailableRows();
  const focusRef = useRef<DOMElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const agents = [
    ...teammates.map((teammate) => ({
      id: `teammate:${JSON.stringify([teammate.teamName, teammate.name])}`,
      label: `@${teammate.name}`,
      summary: `${teammate.teamName} · ${teammate.status} · ${String(teammate.progress.toolUseCount)} tools · ${formatTokens(teammate.progress.tokenCount)} tokens`,
      detail: <TeamDetail teammate={teammate} />,
      kill: onKill
        ? () => {
            onKill(teammate.name, teammate.teamName);
          }
        : undefined,
      shutdown: onShutdown
        ? () => {
            onShutdown(teammate.name, teammate.teamName);
          }
        : undefined,
    })),
    ...backgroundTasks
      .filter((task) => task.kind !== "shell")
      .map((task) => {
        const progress = subagents.find(
          (subagent) => subagent.taskId === task.id,
        );
        return {
          id: `subagent:${task.id}`,
          label: `${task.id}: ${task.name}`,
          summary: `background subagent · ${task.status}${progress ? ` · ${String(progress.turnCount)} turns${progress.lastTool ? ` · ${progress.lastTool}` : ""}` : ""}`,
          detail: <SubagentDetail task={task} progress={progress} />,
          kill:
            task.status === "running" && onStopBackground
              ? () => {
                  onStopBackground(task.id);
                }
              : undefined,
          shutdown: undefined,
        };
      }),
  ];
  const cursor = Math.min(selectedIndex, Math.max(0, agents.length - 1));
  const selected = agents[cursor];
  const detail = detailId
    ? agents.find((agent) => agent.id === detailId)
    : undefined;
  const target = detail ?? selected;
  const actions = [
    ...(target?.kill ? ["k stop"] : []),
    ...(target?.shutdown ? ["s shutdown"] : []),
  ];

  useInput((input, key) => {
    if (detail) {
      if (key.escape || key.leftArrow) {
        setDetailId(null);
      } else if (!key.ctrl && !key.meta && input === "k") {
        detail.kill?.();
      } else if (!key.ctrl && !key.meta && input === "s") {
        detail.shutdown?.();
      }
      return;
    }

    if (key.escape) {
      onClose();
    } else if (key.upArrow) {
      setSelectedIndex(
        cursor > 0 ? cursor - 1 : Math.max(0, agents.length - 1),
      );
    } else if (key.downArrow) {
      setSelectedIndex(cursor < agents.length - 1 ? cursor + 1 : 0);
    } else if (key.return && selected) {
      setDetailId(selected.id);
    } else if (!key.ctrl && !key.meta && input === "k") {
      selected?.kill?.();
    } else if (!key.ctrl && !key.meta && input === "s") {
      selected?.shutdown?.();
    }
  });

  if (detail) {
    return (
      <SelectorFrame
        hint={["←/Escape back", ...actions].join(" · ")}
        title={detail.label}
        subtitle={detail.summary}
      >
        {detail.detail}
      </SelectorFrame>
    );
  }

  const visibleCount = Math.max(
    1,
    Math.min(10, rows - selectorChrome(rows, true, false).height),
  );
  const start = getListWindowStart(agents.length, cursor, visibleCount);
  return (
    <SelectorFrame
      focusRef={focusRef}
      hint={["↑↓ navigate", "Enter detail", ...actions, "Escape close"].join(
        " · ",
      )}
      title="Agents"
      subtitle={`${String(agents.length ? cursor + 1 : 0)}/${String(agents.length)} · teammates and background subagents`}
    >
      {agents.length === 0 ? (
        <Text color={THEME.muted}>No teammates or background subagents</Text>
      ) : null}
      {agents.slice(start, start + visibleCount).map((agent) => {
        const active = agent === selected;
        return (
          <Box
            key={agent.id}
            ref={active ? focusRef : undefined}
            backgroundColor={active ? THEME.selectedBg : undefined}
            paddingLeft={1}
            paddingRight={1}
            width="100%"
          >
            <Text wrap="truncate-end">
              <Text color={active ? THEME.accent : THEME.text}>
                {active ? "› " : "  "}
                {agent.label}
              </Text>
              <Text color={THEME.muted}> · {agent.summary}</Text>
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
    <Box flexDirection="column">
      <Text color={THEME.muted} wrap="truncate-end">
        {elapsed} elapsed · {String(teammate.progress.turnCount)} turns
      </Text>
      {activities.length > 0 ? (
        activities.map((activity, index) => (
          <Text
            key={`${String(index)}-${activity.activityDescription}`}
            color={THEME.muted}
            wrap="truncate-end"
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
    </Box>
  );
}

function SubagentDetail({
  task,
  progress,
}: {
  task: AgentTask;
  progress?: SubagentProgress;
}) {
  const rows = useAvailableRows();
  const output = toDisplayPreview(task.output || progress?.output || "");
  const lines = output.split("\n");
  const limit = Math.max(1, rows - 9);
  return (
    <Box flexDirection="column">
      {progress ? (
        <Text color={THEME.muted} wrap="truncate-end">
          {progress.role} · {String(progress.turnCount)} turns
          {progress.activeTools.length
            ? ` · ${progress.activeTools.map((tool) => tool.toolName).join(", ")}`
            : ""}
        </Text>
      ) : null}
      <Text color={THEME.text} wrap="truncate-end">
        {output ? lines.slice(0, limit).join("\n") : "No output yet"}
      </Text>
      {lines.length > limit ? (
        <Text color={THEME.dim}>
          … {String(lines.length - limit)} more lines
        </Text>
      ) : null}
    </Box>
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
