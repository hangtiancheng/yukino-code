import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

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

export function useAgentOutput(
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>,
) {
  const [streamingText, setStreamingText] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");
  const [retryStatus, setRetryStatus] = useState<string | undefined>();
  const [activeTools, setActiveTools] = useState<ToolBlockInfo[]>([]);
  const [inputTokens, setInputTokens] = useState(0);
  const [outputTokens, setOutputTokens] = useState(0);
  // Session-wide totals, kept in a ref because the exit-summary callback reads
  // them after many renders. `inputTokens` above excludes the cached prefix, so
  // the four counters sum to the real-token baseline.
  const usageTotalsRef = useRef({
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
  });
  const streamingTextRef = useRef("");
  const streamingThinkingRef = useRef("");
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
    cancelFlush();
    streamingTextRef.current = "";
    streamingThinkingRef.current = "";
    setStreamingText("");
    setStreamingThinking("");
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
    usageTotalsRef.current = {
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
  };

  const createEventHandler = (
    resolveAgentCard?: (toolId: string) => AgentCardDecoration | undefined,
  ) => {
    cancelFlush();
    streamingTextRef.current = "";
    streamingThinkingRef.current = "";
    setStreamingText("");
    setStreamingThinking("");
    let fullText = "";
    let turnThinkingText = "";
    let turnThinkingStart = 0;
    let turnThinkingDuration = 0;
    const turnToolCalls = new Map<string, ToolSummaryItem | undefined>();
    const pendingToolArgs = new Map<string, string>();

    const resetThinking = () => {
      turnThinkingText = "";
      turnThinkingStart = 0;
      turnThinkingDuration = 0;
      setStreamingThinking("");
      streamingThinkingRef.current = "";
    };

    const scheduleFlush = () => {
      streamThrottleRef.current ??= setTimeout(() => {
        setStreamingText(streamingTextRef.current);
        setStreamingThinking(streamingThinkingRef.current);
        streamThrottleRef.current = null;
      }, 50);
    };

    const commitOutput = () => {
      cancelFlush();
      setStreamingText("");
      const commits: ChatMessage[] = [];
      if (turnThinkingText || turnThinkingDuration >= 1) {
        commits.push({
          role: "turn_summary",
          content: turnThinkingText,
          thinkingDuration:
            turnThinkingDuration > 0 ? turnThinkingDuration : undefined,
        });
      }
      if (fullText) {
        commits.push({ role: "assistant", content: fullText });
      }
      fullText = "";
      streamingTextRef.current = "";
      resetThinking();
      const completed = new Set<string>();
      const toolSummary: ToolSummaryItem[] = [];
      for (const [toolId, tool] of turnToolCalls) {
        if (tool) {
          toolSummary.push(tool);
          completed.add(toolId);
          turnToolCalls.delete(toolId);
          pendingToolArgs.delete(`${tool.toolName}:${toolId}`);
        }
      }
      if (toolSummary.length > 0) {
        commits.push({ role: "turn_summary", content: "", toolSummary });
        setActiveTools((tools) =>
          tools.filter((tool) => !completed.has(tool.toolId)),
        );
      }
      if (commits.length > 0) {
        setMessages((messages) => [...messages, ...commits]);
      }
    };

    return (event: AgentEvent) => {
      if (
        event.type !== "retry" &&
        event.type !== "usage" &&
        event.type !== "permission_request"
      ) {
        setRetryStatus(undefined);
      }
      switch (event.type) {
        case "stream_text": {
          fullText += event.text;
          streamingTextRef.current = fullText;
          scheduleFlush();
          break;
        }
        case "thinking_text": {
          if (!turnThinkingStart) {
            turnThinkingStart = Date.now();
          }
          turnThinkingText += event.text;
          streamingThinkingRef.current = turnThinkingText;
          scheduleFlush();
          break;
        }
        case "thinking_complete": {
          if (turnThinkingStart) {
            turnThinkingDuration = (Date.now() - turnThinkingStart) / 1000;
          }
          break;
        }
        case "tool_use": {
          pendingToolArgs.set(
            `${event.toolName}:${event.toolId}`,
            formatToolArgs(event.args),
          );
          turnToolCalls.set(event.toolId, undefined);
          const tool: ToolBlockInfo = {
            toolId: event.toolId,
            toolName: event.toolName,
            args: event.args,
            loading: true,
          };
          setActiveTools((tools) => [...tools, tool]);
          break;
        }
        case "tool_result": {
          const output = toDisplayPreview(event.output);
          // Agent calls carry their terminal subagent state (completed /
          // stopped / failed) so the card keeps it after commit; plain tools
          // derive their look from isError alone.
          const decoration =
            event.toolName === "Agent"
              ? resolveAgentCard?.(event.toolId)
              : undefined;
          const completeTool = (tool: ToolBlockInfo): ToolBlockInfo =>
            tool.toolId === event.toolId
              ? {
                  ...tool,
                  output,
                  isError: event.isError,
                  elapsed: event.elapsed,
                  loading: false,
                  ...(decoration?.status ? { status: decoration.status } : {}),
                  ...(decoration?.progress
                    ? { progress: decoration.progress }
                    : {}),
                }
              : tool;
          setActiveTools((tools) => tools.map(completeTool));

          turnToolCalls.set(event.toolId, {
            toolName: event.toolName,
            argsSummary:
              pendingToolArgs.get(`${event.toolName}:${event.toolId}`) ?? "",
            output,
            isError: event.isError,
            elapsed: event.elapsed,
            ...(decoration?.status ? { status: decoration.status } : {}),
            ...(decoration?.progress ? { progress: decoration.progress } : {}),
          });
          if (event.toolName === "AskUserQuestion") {
            // Answered questions must outlive clipping of the live tool viewport.
            commitOutput();
          }
          break;
        }
        case "usage": {
          const totals = usageTotalsRef.current;
          totals.inputTokens += event.usage.inputTokens;
          totals.outputTokens += event.usage.outputTokens;
          totals.cacheReadTokens += event.usage.cacheReadInputTokens;
          totals.cacheCreationTokens += event.usage.cacheCreationInputTokens;
          setInputTokens(totals.inputTokens);
          setOutputTokens(totals.outputTokens);
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
          commitOutput();
          clearTools();
          turnToolCalls.clear();
          pendingToolArgs.clear();
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
    inputTokens,
    outputTokens,
    usageTotalsRef,
    resetUsage,
    prepareTurn,
    finishTurn,
    clearTools,
    createEventHandler,
  };
}
