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

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import type { ChatMessage, ToolSummaryItem } from "./chat.js";
import type { ToolBlockInfo, ToolCardStatus } from "./tool-display.js";

import type { AgentEvent } from "@/agent/events.js";
import { toDisplayPreview } from "@/tool-result/index.js";
import { formatToolArgs } from "@/utils/index.js";

/**
 * Final decoration for an Agent tool card, resolved by the app when the tool
 * result arrives. Carries the subagent's terminal state so committed cards
 * keep the run's real outcome (e.g. an interrupted run renders as "stopped"
 * instead of a green success card).
 */
export interface AgentCardDecoration {
  status?: ToolCardStatus;
  progress?: string;
}

export function useAgentOutput(setMessages: Dispatch<SetStateAction<ChatMessage[]>>) {
  const [streamingText, setStreamingText] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");
  const [retryStatus, setRetryStatus] = useState<string | undefined>();
  const [activeTools, setActiveTools] = useState<ToolBlockInfo[]>([]);
  const [persistentAgentTools, setPersistentAgentTools] = useState<ToolBlockInfo[]>([]);
  const [inputTokens, setInputTokens] = useState(0);
  const [outputTokens, setOutputTokens] = useState(0);
  const streamingTextRef = useRef("");
  const streamThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelFlush = () => {
    if (streamThrottleRef.current) {
      clearTimeout(streamThrottleRef.current);
      streamThrottleRef.current = null;
    }
  };

  useEffect(() => cancelFlush, []);

  const clearTools = () => {
    setActiveTools([]);
  };

  const prepareTurn = () => {
    setStreamingText("");
    setRetryStatus(undefined);
    clearTools();
  };

  const finishTurn = () => {
    cancelFlush();
    setStreamingThinking("");
    setRetryStatus(undefined);
    clearTools();
  };

  const resetUsage = () => {
    setInputTokens(0);
    setOutputTokens(0);
    setPersistentAgentTools([]);
  };

  const createEventHandler = (
    resolveAgentCard?: (toolId: string) => AgentCardDecoration | undefined,
  ) => {
    setStreamingThinking("");
    let fullText = "";
    let turnThinkingText = "";
    let turnThinkingStart = 0;
    let turnThinkingDuration = 0;
    const turnToolCalls = new Map<string, ToolSummaryItem | undefined>();
    const pendingToolArgs = new Map<string, string>();
    const persistentAgentToolIds = new Set<string>();
    const pendingTeamDeletes = new Map<string, string>();

    const resetTurn = () => {
      turnThinkingText = "";
      turnThinkingStart = 0;
      turnThinkingDuration = 0;
      turnToolCalls.clear();
      setStreamingThinking("");
      pendingToolArgs.clear();
      persistentAgentToolIds.clear();
      pendingTeamDeletes.clear();
    };

    return (event: AgentEvent) => {
      if (event.type !== "retry" && event.type !== "usage" && event.type !== "permission_request") {
        setRetryStatus(undefined);
      }
      switch (event.type) {
        case "stream_text": {
          fullText += event.text;
          streamingTextRef.current = fullText;
          streamThrottleRef.current ??= setTimeout(() => {
            setStreamingText(streamingTextRef.current);
            streamThrottleRef.current = null;
          }, 50);
          break;
        }
        case "thinking_text": {
          if (!turnThinkingStart) {
            turnThinkingStart = Date.now();
          }
          turnThinkingText += event.text;
          setStreamingThinking(turnThinkingText);
          break;
        }
        case "thinking_complete": {
          if (turnThinkingStart) {
            turnThinkingDuration = (Date.now() - turnThinkingStart) / 1000;
          }
          break;
        }
        case "tool_use": {
          pendingToolArgs.set(`${event.toolName}:${event.toolId}`, formatToolArgs(event.args));
          turnToolCalls.set(event.toolId, undefined);
          const tool: ToolBlockInfo = {
            toolId: event.toolId,
            toolName: event.toolName,
            args: event.args,
            loading: true,
          };
          setActiveTools((tools) => [...tools, tool]);
          // Only teammate spawns stay pinned across turns. One-shot background
          // agents (run_in_background) commit to history like any other tool
          // call — their result reaches the user as a task notification.
          const teamName = event.args.team_name;
          if (event.toolName === "Agent" && typeof teamName === "string" && teamName) {
            persistentAgentToolIds.add(event.toolId);
            setPersistentAgentTools((tools) => [
              ...tools.filter((item) => item.toolId !== event.toolId),
              {
                ...tool,
                args: {
                  description: event.args.description,
                  team_name: teamName,
                },
              },
            ]);
          }
          if (event.toolName === "TeamDelete" && typeof event.args.name === "string") {
            pendingTeamDeletes.set(event.toolId, event.args.name);
          }
          break;
        }
        case "tool_result": {
          const output = toDisplayPreview(event.output);
          // Agent calls carry their terminal subagent state (completed /
          // stopped / failed) so the card keeps it after commit; plain tools
          // derive their look from isError alone.
          const decoration =
            event.toolName === "Agent" ? resolveAgentCard?.(event.toolId) : undefined;
          const completeTool = (tool: ToolBlockInfo): ToolBlockInfo =>
            tool.toolId === event.toolId
              ? {
                  ...tool,
                  output,
                  isError: event.isError,
                  elapsed: event.elapsed,
                  loading: false,
                  ...(decoration?.status ? { status: decoration.status } : {}),
                  ...(decoration?.progress ? { progress: decoration.progress } : {}),
                }
              : tool;
          setActiveTools((tools) => tools.map(completeTool));

          const deletedTeam = pendingTeamDeletes.get(event.toolId);
          if (deletedTeam && !event.isError) {
            setPersistentAgentTools((tools) =>
              tools.filter((tool) => tool.args.team_name !== deletedTeam),
            );
          }

          // TeamCreate enforces single-team semantics: every existing team is
          // deleted before the new one is created, so all pinned teammate
          // cards are stale and must go.
          if (event.toolName === "TeamCreate" && !event.isError) {
            setPersistentAgentTools([]);
          }

          if (persistentAgentToolIds.has(event.toolId) && !event.isError) {
            setPersistentAgentTools((tools) => tools.map(completeTool));
            turnToolCalls.delete(event.toolId);
          } else {
            if (persistentAgentToolIds.has(event.toolId)) {
              setPersistentAgentTools((tools) =>
                tools.filter((tool) => tool.toolId !== event.toolId),
              );
            }
            turnToolCalls.set(event.toolId, {
              toolName: event.toolName,
              argsSummary: pendingToolArgs.get(`${event.toolName}:${event.toolId}`) ?? "",
              output,
              isError: event.isError,
              elapsed: event.elapsed,
              ...(decoration?.status ? { status: decoration.status } : {}),
              ...(decoration?.progress ? { progress: decoration.progress } : {}),
            });
          }
          break;
        }
        case "usage": {
          setInputTokens((tokens) => tokens + event.usage.inputTokens);
          setOutputTokens((tokens) => tokens + event.usage.outputTokens);
          break;
        }
        case "compact": {
          setMessages((messages) => [
            ...messages,
            { role: "system", content: `⊙ ${event.message}` },
          ]);
          break;
        }
        case "retry": {
          setRetryStatus(
            `Retrying${event.delay ? ` (${String(Math.round(event.delay / 1000))}s delay)` : ""}: ${event.reason}`,
          );
          setMessages((messages) => [
            ...messages,
            {
              role: "system",
              content: `↻ ${event.reason}${event.delay ? ` (waiting ${String(Math.round(event.delay / 1000))}s)` : ""}`,
            },
          ]);
          break;
        }
        case "turn_complete":
        case "loop_complete": {
          cancelFlush();
          setStreamingText("");
          const turnText = fullText;
          fullText = "";
          streamingTextRef.current = "";
          clearTools();
          const commits: ChatMessage[] = [];
          if (turnThinkingText || turnThinkingDuration >= 1) {
            commits.push({
              role: "turn_summary",
              content: turnThinkingText,
              thinkingDuration: turnThinkingDuration > 0 ? turnThinkingDuration : undefined,
            });
          }
          if (turnText) {
            commits.push({ role: "assistant", content: turnText });
          }
          const toolSummary = [...turnToolCalls.values()].filter(
            (tool): tool is ToolSummaryItem => tool !== undefined,
          );
          if (toolSummary.length > 0) {
            commits.push({ role: "turn_summary", content: "", toolSummary });
          }
          if (commits.length > 0) {
            setMessages((messages) => [...messages, ...commits]);
          }
          resetTurn();
          break;
        }
      }
    };
  };

  return {
    streamingText,
    streamingThinking,
    retryStatus,
    streamingTextRef,
    activeTools,
    persistentAgentTools,
    inputTokens,
    outputTokens,
    resetUsage,
    prepareTurn,
    finishTurn,
    clearTools,
    createEventHandler,
  };
}
