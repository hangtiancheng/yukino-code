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

import { describe, expect, it } from "vitest";

import { formatInteractionSummary } from "@/bootstrap/interaction-summary.js";

/** Mirrors the summary's field layout so tests do not hand-count padding. */
function field(label: string, value: string): string {
  return ` ${`${label}:`.padEnd(28)}${value}`;
}

describe("interaction summary", () => {
  it("prints session, tool, and timing metrics with a resume command", () => {
    const output = formatInteractionSummary(
      {
        agentActiveMs: 10_000,
        cacheCreationTokens: 2_000,
        cacheReadTokens: 8_000,
        failedToolCalls: 1,
        inputTokens: 2_000,
        outputTokens: 500,
        sessionId: "session-123",
        startedAt: 1_000,
        successfulToolCalls: 3,
        toolTimeMs: 4_000,
      },
      16_000,
    );

    expect(output).toContain("Interaction Summary");
    expect(output).toContain(field("Session ID", "session-123"));
    expect(output).toContain(field("Tool Calls", "4 ( ✓ 3 ✗ 1 )"));
    expect(output).toContain(field("Success Rate", "75.0%"));
    expect(output).toContain(field("Agent Active", "10s"));
    expect(output).toContain(field("  > API Time", "6s (60.0%)"));
    expect(output).toContain(field("  > Tool Time", "4s (40.0%)"));
    expect(output).toContain("Tokens");
    expect(output).toContain(field("Input", "2.0k"));
    expect(output).toContain(field("  > Cache Read", "8.0k"));
    expect(output).toContain(field("  > Cache Write", "2.0k"));
    expect(output).toContain(field("Output", "500"));
    expect(output).toContain(field("Cache Hit", "66.7% (8.0k of 12k prompt)"));
    expect(output).toContain("yukino --resume session-123");
  });

  it("prints zero rates when no tools or agent work occurred", () => {
    const output = formatInteractionSummary(
      {
        agentActiveMs: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        failedToolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        sessionId: "empty",
        startedAt: 1_000,
        successfulToolCalls: 0,
        toolTimeMs: 0,
      },
      1_000,
    );

    expect(output).toContain(field("Success Rate", "0.0%"));
    expect(output).toContain(field("  > API Time", "0s (0.0%)"));
    expect(output).toContain(field("  > Tool Time", "0s (0.0%)"));
    expect(output).toContain(field("Cache Hit", "0.0% (0 of 0 prompt)"));
  });

  it("reports cache write tokens when nothing was served from cache", () => {
    const output = formatInteractionSummary(
      {
        agentActiveMs: 1_000,
        cacheCreationTokens: 20_000,
        cacheReadTokens: 0,
        failedToolCalls: 0,
        inputTokens: 5_000,
        outputTokens: 0,
        sessionId: "cold",
        startedAt: 0,
        successfulToolCalls: 0,
        toolTimeMs: 0,
      },
      1_000,
    );

    expect(output).toContain(field("Cache Hit", "0.0% (0 of 25k prompt)"));
    expect(output).toContain(field("  > Cache Write", "20k"));
  });

  it("scales token formatting from raw counts to millions", () => {
    const output = formatInteractionSummary(
      {
        agentActiveMs: 1_000,
        cacheCreationTokens: 1_000_000,
        cacheReadTokens: 2_500_000,
        failedToolCalls: 0,
        inputTokens: 999,
        outputTokens: 0,
        sessionId: "big",
        startedAt: 0,
        successfulToolCalls: 0,
        toolTimeMs: 0,
      },
      1_000,
    );

    expect(output).toContain(field("Input", "999"));
    expect(output).toContain(field("  > Cache Read", "2.5M"));
    expect(output).toContain(field("  > Cache Write", "1.0M"));
    expect(output).toContain(field("Cache Hit", "71.4% (2.5M of 3.5M prompt)"));
  });
});
