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

// Structured logging for AgentEvent streams, filtered to what matters at the
// recorded level (warn and above): degraded-service signals and errors.
//   { "event": "retry", "reason": ..., "time": <pino timestamp> }
// Routine progress events (tool_use, streamed text, turn/loop completion,
// usage, permission requests) are intentionally not logged.

import type { AgentEvent } from "@/agent/events.js";

/** Minimal pino Logger shape (warn/error) to keep this module generic. */
export interface EventLogger {
  warn(obj: Record<string, unknown>): void;
  error(obj: Record<string, unknown>): void;
}

/** Max characters of tool output kept in a log line. */
const TEXT_PREVIEW_CHARS = 800;

function preview(text: string): string {
  if (text.length <= TEXT_PREVIEW_CHARS) {
    return text;
  }
  return `${text.slice(0, TEXT_PREVIEW_CHARS)}… (+${String(text.length - TEXT_PREVIEW_CHARS)} chars)`;
}

export class AgentEventLogger {
  constructor(private readonly log: EventLogger) {}

  /**
   * Log noteworthy AgentEvents as structured JSONL lines:
   * - failed tool results and compact/retry (degraded service) at warn
   * - agent errors at error
   * Everything else is routine progress and is dropped.
   */
  onEvent(ev: AgentEvent): void {
    switch (ev.type) {
      case "tool_result": {
        if (!ev.isError) {
          return;
        }
        const output = ev.output;
        this.log.warn({
          event: "tool_result",
          tool: ev.toolName,
          toolId: ev.toolId,
          isError: true,
          elapsedMs: Math.round(ev.elapsed * 1000),
          outputChars: output.length,
          output: preview(output),
        });
        return;
      }

      case "retry":
        this.log.warn({ event: "retry", reason: ev.reason, delayMs: ev.delay });
        return;

      case "compact":
        this.log.warn({ event: "compact", message: ev.message });
        return;

      case "error":
        this.log.error({ event: "error", err: ev.error });
        return;

      default:
        return;
    }
  }
}
