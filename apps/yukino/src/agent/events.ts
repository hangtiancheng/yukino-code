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
  | { type: "usage"; usage: UsageInfo }
  | { type: "error"; error: Error }
  // `boundary` is present when the compaction actually rewrote the transcript;
  // the layer holding the sessionId persists it as a compact_boundary record.
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
