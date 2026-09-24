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

export interface InteractionSummary {
  agentActiveMs: number;
  failedToolCalls: number;
  sessionId: string;
  startedAt: number;
  successfulToolCalls: number;
  toolTimeMs: number;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) {
    return `${String(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes)}m ${String(remainder)}s`;
}

function percentage(value: number, total: number): string {
  return `${(total > 0 ? (value / total) * 100 : 0).toFixed(1)}%`;
}

function field(label: string, value: string): string {
  return ` ${`${label}:`.padEnd(28)}${value}`;
}

export function formatInteractionSummary(
  summary: InteractionSummary,
  endedAt = Date.now(),
): string {
  const totalToolCalls = summary.successfulToolCalls + summary.failedToolCalls;
  const apiTimeMs = Math.max(0, summary.agentActiveMs - summary.toolTimeMs);
  const successRate =
    totalToolCalls > 0
      ? (summary.successfulToolCalls / totalToolCalls) * 100
      : 0;

  return [
    " Interaction Summary",
    field("Session ID", summary.sessionId),
    field(
      "Tool Calls",
      `${String(totalToolCalls)} ( ✓ ${String(summary.successfulToolCalls)} x ${String(summary.failedToolCalls)} )`,
    ),
    field("Success Rate", `${successRate.toFixed(1)}%`),
    "",
    " Performance",
    field("Wall Time", formatDuration(endedAt - summary.startedAt)),

    field("Agent Active", formatDuration(summary.agentActiveMs)),
    field(
      "  > API Time",
      `${formatDuration(apiTimeMs)} (${percentage(apiTimeMs, summary.agentActiveMs)})`,
    ),
    field(
      "  > Tool Time",
      `${formatDuration(summary.toolTimeMs)} (${percentage(summary.toolTimeMs, summary.agentActiveMs)})`,
    ),
    "",
    ` To resume this session: yukino --resume ${summary.sessionId}`,
  ].join("\n");
}
