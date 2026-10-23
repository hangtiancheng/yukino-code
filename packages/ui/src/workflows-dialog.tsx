import { Box, Text, useInput } from "ink";
import { useEffect, useState, useSyncExternalStore } from "react";

import type { ToolContext } from "@yukino.js/tools/types.js";
import { THEME } from "./constants.js";
import { getListWindowStart } from "./list-window.js";
import { SelectorFrame } from "./selector-frame.js";
import { plainTerminalLine } from "./terminal-text.js";
import {
  useAvailableRows,
  useTerminalDimensions,
} from "./use-terminal-layout.js";
import { asErrorString } from "@yukino.js/utils";
import {
  MAX_VISIBLE_RUNS,
  WORKFLOW_PANEL_EMPTY,
  WORKFLOW_PANEL_HINT,
  WORKFLOW_PANEL_TITLE,
} from "@yukino.js/workflow/constants.js";
import type { WorkflowService } from "@yukino.js/workflow/service.js";

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
  const visibleCount = Math.max(1, rows - 9);
  const start = getListWindowStart(
    run?.agents.length ?? 0,
    agentIndex,
    visibleCount,
  );
  const wide = columns >= 65;
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
          : WORKFLOW_PANEL_HINT
      }
    >
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          {runs
            .map(
              (item, index) =>
                `${index === runIndex ? "▶ " : ""}${plainTerminalLine(item.workflowName)} (${item.status})`,
            )
            .join("  ")}
        </Text>
        <Box flexDirection="row">
          {wide && (
            <Box width="30%" flexDirection="column">
              <Text bold color={THEME.accent}>
                Phases
              </Text>
              {run?.phases.slice(0, visibleCount).map((phase, index) => (
                <Text key={index} wrap="truncate-end">
                  {phase.status === "done"
                    ? "✓"
                    : phase.status === "running"
                      ? "●"
                      : "○"}{" "}
                  {plainTerminalLine(phase.title)}
                </Text>
              ))}
            </Box>
          )}
          <Box flexGrow={1} flexDirection="column">
            <Text bold color={THEME.accent}>
              Agents
            </Text>
            {run?.agents
              .slice(start, start + visibleCount)
              .map((agent, index) => (
                <Text
                  key={agent.id}
                  color={
                    start + index === agentIndex ? THEME.accent : undefined
                  }
                  wrap="truncate-end"
                >
                  {start + index === agentIndex ? "▶" : " "} #{agent.id}{" "}
                  {plainTerminalLine(agent.label ?? agent.phase ?? "agent")} ·{" "}
                  {agent.resultKind ?? agent.status} · {agent.tokenCount} tokens
                  · {agent.toolCount} tools
                </Text>
              ))}
          </Box>
        </Box>
        {run?.error && (
          <Text color={THEME.error} wrap="truncate-end">
            {plainTerminalLine(run.error)}
          </Text>
        )}
        {run?.logs.slice(-1).map((line, index) => (
          <Text key={index} dimColor wrap="truncate-end">
            {plainTerminalLine(line)}
          </Text>
        ))}
        {resuming && <Text>Resuming workflow…</Text>}
        {error && (
          <Text color={THEME.error} wrap="truncate-end">
            {plainTerminalLine(error)}
          </Text>
        )}
      </Box>
    </SelectorFrame>
  );
}
