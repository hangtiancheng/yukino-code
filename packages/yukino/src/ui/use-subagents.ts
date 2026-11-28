import { useCallback, useEffect, useRef, useState } from "react";

import type { RuntimeSubagentEvent } from "@/runtime/types.js";
import type { AgentEventSink } from "@/subagent/spawn.js";
import type { TaskManager } from "@/subagent/task-manager.js";
import type { SubagentProgress } from "@/ui/agent-tool-progress.js";
import type { AgentCardDecoration } from "@/ui/use-agent-output.js";
import { asErrorString } from "@/utils/index.js";

interface Tracking {
  toolCallId: string;
  role: string;
  taskId?: string;
  abortSignal?: AbortSignal;
}

export function useSubagents(taskManager: TaskManager) {
  const [subagents, setSubagents] = useState<SubagentProgress[]>([]);
  const cardsRef = useRef(new Map<string, AgentCardDecoration>());

  useEffect(
    () =>
      taskManager.subscribe((tasks) => {
        const running = new Set(
          tasks
            .filter((task) => task.status === "running")
            .map((task) => task.id),
        );
        setSubagents((previous) =>
          previous.filter(
            (subagent) => !subagent.taskId || running.has(subagent.taskId),
          ),
        );
      }),
    [taskManager],
  );

  const prepareTurn = useCallback(() => {
    cardsRef.current.clear();
    setSubagents((previous) =>
      previous.filter(
        (subagent) =>
          subagent.taskId &&
          taskManager.get(subagent.taskId)?.status === "running",
      ),
    );
  }, [taskManager]);

  const reset = useCallback(() => {
    setSubagents([]);
    cardsRef.current.clear();
  }, []);

  const track = useCallback(
    async (
      { toolCallId, role, taskId, abortSignal }: Tracking,
      run: (onEvent: AgentEventSink) => Promise<string>,
    ): Promise<string> => {
      const runningTools = new Map<string, string>();
      let turns = 0;
      let lastTool: string | undefined;
      const syncRunningTools = () => {
        const activeTools = [...runningTools].map(([toolId, toolName]) => ({
          toolId,
          toolName,
        }));
        setSubagents((previous) =>
          previous.map((subagent) =>
            subagent.toolCallId === toolCallId
              ? { ...subagent, activeTools, lastTool }
              : subagent,
          ),
        );
      };
      if (!taskId || taskManager.get(taskId)?.status === "running") {
        setSubagents((previous) => [
          ...previous.filter((subagent) => subagent.toolCallId !== toolCallId),
          {
            toolCallId,
            taskId,
            role,
            turnCount: 0,
            activeTools: [],
            status: "running",
          },
        ]);
      }
      const finalize = (status: SubagentProgress["status"], output: string) => {
        if (taskId) {
          setSubagents((previous) =>
            previous.filter((subagent) => subagent.taskId !== taskId),
          );
          return;
        }
        cardsRef.current.set(toolCallId, {
          status,
          progress: `${role} subagent | ${String(turns)} turns`,
        });
        setSubagents((previous) =>
          previous.map((subagent) =>
            subagent.toolCallId === toolCallId
              ? {
                  ...subagent,
                  activeTools: [],
                  lastTool: undefined,
                  status,
                  output,
                }
              : subagent,
          ),
        );
      };
      const onEvent: AgentEventSink = (event) => {
        switch (event.type) {
          case "tool_use":
            lastTool = event.toolName;
            runningTools.set(event.toolId, event.toolName);
            syncRunningTools();
            break;
          case "tool_result":
            runningTools.delete(event.toolId);
            syncRunningTools();
            break;
          case "turn_complete":
            runningTools.clear();
            turns += 1;
            setSubagents((previous) =>
              previous.map((subagent) =>
                subagent.toolCallId === toolCallId
                  ? { ...subagent, turnCount: turns, activeTools: [] }
                  : subagent,
              ),
            );
            break;
          case "usage":
            break;
        }
      };
      try {
        const result = await run(onEvent);
        finalize(abortSignal?.aborted ? "stopped" : "completed", result);
        return result;
      } catch (error) {
        finalize(
          abortSignal?.aborted ? "stopped" : "failed",
          `Agent error: ${asErrorString(error)}`,
        );
        throw error;
      }
    },
    [taskManager],
  );

  const runtimeTurns = useRef(new Map<string, number>());
  const receive = useCallback((event: RuntimeSubagentEvent) => {
    if (event.type === "started") {
      runtimeTurns.current.set(event.toolCallId, 0);
    }
    if (event.type === "turn_complete") {
      runtimeTurns.current.set(
        event.toolCallId,
        (runtimeTurns.current.get(event.toolCallId) ?? 0) + 1,
      );
    }
    if (event.type === "finished") {
      cardsRef.current.set(event.toolCallId, {
        status: event.status,
        progress: `${event.role} subagent | ${String(runtimeTurns.current.get(event.toolCallId) ?? 0)} turns`,
      });
      runtimeTurns.current.delete(event.toolCallId);
    }
    setSubagents((previous) => {
      if (event.type === "started") {
        return [
          ...previous.filter((item) => item.toolCallId !== event.toolCallId),
          {
            toolCallId: event.toolCallId,
            role: event.role,
            turnCount: 0,
            activeTools: [],
            status: "running",
          },
        ];
      }
      return previous.map((item) => {
        if (item.toolCallId !== event.toolCallId) {
          return item;
        }
        if (event.type === "tool_use") {
          return {
            ...item,
            lastTool: event.toolName,
            activeTools: [
              ...item.activeTools,
              { toolId: event.toolId, toolName: event.toolName },
            ],
          };
        }
        if (event.type === "tool_result") {
          return {
            ...item,
            activeTools: item.activeTools.filter(
              (tool) => tool.toolId !== event.toolId,
            ),
          };
        }
        if (event.type === "turn_complete") {
          return { ...item, turnCount: item.turnCount + 1, activeTools: [] };
        }
        if (event.type === "finished") {
          return { ...item, status: event.status, activeTools: [] };
        }
        return item;
      });
    });
  }, []);

  return { subagents, cardsRef, track, prepareTurn, reset, receive };
}
