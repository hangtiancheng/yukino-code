import { Box, Text, useInput } from "ink";
import { useEffect, useState, useSyncExternalStore } from "react";

import type { ToolContext } from "@/tools/types.js";
import { THEME } from "@/ui/constants.js";
import { getListWindowStart } from "@/ui/list-window.js";
import { SelectorFrame } from "@/ui/selector-frame.js";
import { selectorChrome } from "@/ui/selector-layout.js";
import { plainTerminalLine, truncateToWidth } from "@/ui/terminal-text.js";
import {
  useAvailableRows,
  useTerminalDimensions,
} from "@/ui/use-terminal-layout.js";
import { asErrorString } from "@/utils/index.js";
import {
  MAX_VISIBLE_RUNS,
  WORKFLOW_PANEL_EMPTY,
  WORKFLOW_PANEL_COMPACT_HINT,
  WORKFLOW_PANEL_HINT,
  WORKFLOW_PANEL_TITLE,
} from "@/workflow/constants.js";
import type { WorkflowService } from "@/workflow/service.js";

interface Props {
  service: WorkflowService;
  context: () => ToolContext;
  onClose: () => void;
}

export function WorkflowsDialog({ service, context, onClose }: Props) {
  const runs = useSyncExternalStore(
    service.store.subscribe,
    service.store.getSnapshot,
  ).slice(0, MAX_VISIBLE_RUNS);
  const rows = useAvailableRows();
  const { columns } = useTerminalDimensions();
  const [selectedRun, setSelectedRun] = useState(0);
  const [selectedAgent, setSelectedAgent] = useState(0);
  const [error, setError] = useState("");
  const [resuming, setResuming] = useState(false);
  const [confirm, setConfirm] = useState<{
    runId: string;
    agentId?: number;
  } | null>(null);
  const runIndex = Math.min(selectedRun, Math.max(0, runs.length - 1));
  const run = runs[runIndex];
  const agentIndex = Math.min(
    selectedAgent,
    Math.max(0, (run?.agents.length ?? 0) - 1),
  );
  useEffect(() => {
    void service.loadPersistedRuns().catch((reason: unknown) => {
      setError(asErrorString(reason));
    });
  }, [service]);
  useInput((input, key) => {
    if (confirm) {
      if (input.toLowerCase() === "y" || key.return) {
        if (confirm.agentId !== undefined) {
          service.killAgent(confirm.runId, confirm.agentId);
        } else {
          service.kill(confirm.runId);
        }
        setConfirm(null);
      } else if (key.escape || input.toLowerCase() === "n") {
        setConfirm(null);
      }
      return;
    }
    if (key.escape || input === "q") {
      onClose();
      return;
    }
    if (key.tab && runs.length) {
      setSelectedRun(
        (runIndex + (key.shift ? runs.length - 1 : 1)) % runs.length,
      );
      setSelectedAgent(0);
    }
    if (key.upArrow) {
      setSelectedAgent(Math.max(0, agentIndex - 1));
    }
    if (key.downArrow) {
      setSelectedAgent(
        Math.min(Math.max(0, (run?.agents.length ?? 0) - 1), agentIndex + 1),
      );
    }
    if (input === "K" && run?.status === "running") {
      setConfirm({ runId: run.runId });
    }
    if (input === "x" && run?.agents[agentIndex]?.status === "running") {
      setConfirm({ runId: run.runId, agentId: run.agents[agentIndex].id });
    }
    if (input === "r" && run && run.status !== "running" && !resuming) {
      setResuming(true);
      setError("");
      void service
        .launch({ resumeFromRunId: run.runId }, context())
        .catch((reason: unknown) => {
          setError(asErrorString(reason));
        })
        .finally(() => {
          setResuming(false);
        });
    }
  });
  const contentRows = Math.max(0, rows - selectorChrome(rows, true).height);
  const wide = columns >= 65;
  const roomy = contentRows >= 10;
  const notices =
    Number(!!run?.error) +
    Number(!!error) +
    Number(resuming) +
    Number(!!run?.logs.length);
  const agentRowHeight = !wide && contentRows - 3 - notices >= 2 ? 2 : 1;
  const visibleCount = Math.max(
    1,
    Math.floor((contentRows - 3 - Number(roomy) - notices) / agentRowHeight),
  );
  const start = getListWindowStart(
    run?.agents.length ?? 0,
    agentIndex,
    visibleCount,
  );
  const phaseRows = visibleCount * agentRowHeight;
  const phaseStart = getListWindowStart(
    run?.phases.length ?? 0,
    Math.max(
      0,
      run?.phases.findIndex((phase) => phase.status === "running") ?? 0,
    ),
    phaseRows,
  );
  const tabCount = Math.max(1, Math.floor((columns - 2) / 24));
  const tabStart = getListWindowStart(runs.length, runIndex, tabCount);
  const tabWidth = Math.max(
    1,
    Math.floor((columns - 2) / Math.min(tabCount, Math.max(1, runs.length))),
  );
  return (
    <SelectorFrame
      title={WORKFLOW_PANEL_TITLE}
      subtitle={
        run
          ? `${run.workflowName} · ${run.status} · ${run.runId}`
          : WORKFLOW_PANEL_EMPTY
      }
      hint={
        confirm
          ? "Stop selected work? y/Enter confirm · n/Esc cancel"
          : wide
            ? WORKFLOW_PANEL_HINT
            : WORKFLOW_PANEL_COMPACT_HINT
      }
    >
      <Box flexDirection="column">
        {run ? (
          <>
            <Box>
              {runs.slice(tabStart, tabStart + tabCount).map((item, index) => {
                const active = tabStart + index === runIndex;
                return (
                  <Box
                    key={item.runId}
                    width={tabWidth}
                    backgroundColor={active ? THEME.selectedBg : undefined}
                  >
                    <Text
                      bold={active}
                      color={active ? THEME.accent : THEME.muted}
                      wrap="truncate-end"
                    >
                      {truncateToWidth(
                        ` ${tabStart + index + 1} ${plainTerminalLine(item.workflowName)} `,
                        tabWidth,
                      )}
                    </Text>
                  </Box>
                );
              })}
            </Box>
            <Text wrap="truncate-end">
              <Text color={workflowStatusColor(run.status)}>
                {workflowStatusIcon(run.status)} {run.status}
              </Text>
              <Text color={THEME.muted}>
                {` · ${run.phases.filter((phase) => phase.status === "done").length}/${run.phases.length} phases · ${run.agents.length} agents`}
              </Text>
            </Text>
            <Box flexDirection="row" marginTop={roomy ? 1 : 0}>
              {wide && (
                <Box
                  width="30%"
                  flexShrink={0}
                  flexDirection="column"
                  paddingRight={2}
                >
                  <Text
                    bold
                    color={THEME.customMessageLabel}
                    wrap="truncate-end"
                  >
                    Phases
                  </Text>
                  {run.phases.length === 0 && (
                    <Text color={THEME.dim}>No phases yet</Text>
                  )}
                  {run.phases
                    .slice(phaseStart, phaseStart + phaseRows)
                    .map((phase, index) => (
                      <Text
                        key={phaseStart + index}
                        color={workflowStatusColor(phase.status)}
                        wrap="truncate-end"
                      >
                        {workflowStatusIcon(phase.status)}{" "}
                        <Text
                          color={
                            phase.status === "pending" ? THEME.dim : THEME.text
                          }
                        >
                          {plainTerminalLine(phase.title)}
                        </Text>
                      </Text>
                    ))}
                </Box>
              )}
              <Box flexGrow={1} minWidth={0} flexDirection="column">
                <Text bold color={THEME.customMessageLabel} wrap="truncate-end">
                  Agents{" "}
                  <Text color={THEME.dim}>
                    {run.agents.length
                      ? `${agentIndex + 1}/${run.agents.length}`
                      : "0"}
                  </Text>
                </Text>
                {run.agents.length === 0 && (
                  <Text color={THEME.dim}>No agents yet</Text>
                )}
                {run.agents
                  .slice(start, start + visibleCount)
                  .map((agent, index) => {
                    const active = start + index === agentIndex;
                    const status = agent.resultKind ?? agent.status;
                    return (
                      <Box
                        key={agent.id}
                        flexDirection="column"
                        backgroundColor={active ? THEME.selectedBg : undefined}
                      >
                        <Text wrap="truncate-end">
                          <Text color={active ? THEME.accent : THEME.dim}>
                            {active ? "› " : "  "}
                          </Text>
                          <Text color={workflowStatusColor(status)}>
                            {workflowStatusIcon(status)}{" "}
                          </Text>
                          <Text
                            bold={active}
                            color={active ? THEME.accent : THEME.text}
                          >
                            #{agent.id}{" "}
                            {plainTerminalLine(
                              agent.label ?? agent.phase ?? "agent",
                            )}
                          </Text>
                          {agentRowHeight === 1 && (
                            <Text color={THEME.muted}>
                              {" "}
                              · {status} · {agent.tokenCount} tokens ·{" "}
                              {agent.toolCount} tools
                            </Text>
                          )}
                        </Text>
                        {agentRowHeight === 2 && (
                          <Text color={THEME.muted} wrap="truncate-end">
                            {" "}
                            {status} · {agent.tokenCount} tokens ·{" "}
                            {agent.toolCount} tools
                          </Text>
                        )}
                      </Box>
                    );
                  })}
              </Box>
            </Box>
          </>
        ) : (
          <Text color={THEME.muted}>{WORKFLOW_PANEL_EMPTY}</Text>
        )}
        {run?.error && (
          <Text color={THEME.error} wrap="truncate-end">
            {plainTerminalLine(run.error)}
          </Text>
        )}
        {run?.logs.slice(-1).map((line, index) => (
          <Text key={index} color={THEME.dim} wrap="truncate-end">
            {plainTerminalLine(line)}
          </Text>
        ))}
        {resuming && <Text color={THEME.accent}>Resuming workflow…</Text>}
        {error && (
          <Text color={THEME.error} wrap="truncate-end">
            {plainTerminalLine(error)}
          </Text>
        )}
      </Box>
    </SelectorFrame>
  );
}

function workflowStatusColor(status: string): string {
  switch (status) {
    case "running":
      return THEME.accent;
    case "completed":
    case "done":
    case "ok":
      return THEME.success;
    case "failed":
    case "dead":
      return THEME.error;
    case "killed":
    case "cancelled":
    case "skipped":
      return THEME.warning;
    default:
      return THEME.dim;
  }
}

function workflowStatusIcon(status: string): string {
  switch (status) {
    case "running":
      return "●";
    case "completed":
    case "done":
    case "ok":
      return "✓";
    case "failed":
    case "dead":
      return "✗";
    case "killed":
    case "cancelled":
    case "skipped":
      return "–";
    default:
      return "○";
  }
}
