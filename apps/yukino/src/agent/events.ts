import type { UsageInfo } from "@/llm/events.js";
import type { CompactBoundaryPayload } from "@/session/index.js";
import type { ToolResultContentBlock } from "@/tools/types.js";

export type AgentEvent =
  | { type: "stream_text"; text: string }
  | { type: "thinking_text"; text: string }
  | { type: "thinking_complete"; thinking: string; signature: string }
  | {
      type: "tool_use";
      toolName: string;
      toolId: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      toolName: string;
      toolId: string;
      output: string;
      contentBlocks?: ToolResultContentBlock[];
      isError: boolean;
      elapsed: number;
    }
  | { type: "turn_complete" }
  | { type: "loop_complete"; stopReason: string }
  // A queued steering message was injected into the conversation at a turn
  // boundary (after tool results, before the next LLM call).
  | { type: "steering_delivered"; text: string }
  | { type: "usage"; usage: UsageInfo }
  | { type: "error"; error: Error }
  // `boundary` is present when the compaction actually rewrote the transcript;
  // Agent persists it before publication when it owns a sessionId.
  | {
      type: "compact";
      message: string;
      boundary?: CompactBoundaryPayload | undefined;
    }
  | { type: "retry"; reason: string; delay: number }
  | {
      type: "permission_request";
      toolName: string;
      args: Record<string, unknown>;
    };
