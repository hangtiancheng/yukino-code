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

import {
  addUsage,
  agentEventToUpdate,
  emptyUsage,
  historyNotifications,
  promptToText,
  stopReason,
  toolKind,
} from "@/acp/conversion.js";
import type { SessionMessage } from "@/session/index.js";

describe("ACP conversion", () => {
  it("converts supported prompt blocks to text", () => {
    expect(
      promptToText([
        { type: "text", text: "Review this" },
        { type: "resource_link", name: "README", uri: "file:///repo/README.md" },
        {
          type: "resource",
          resource: { uri: "file:///repo/context.txt", text: "context" },
        },
      ]),
    ).toBe(
      "Review this\n\nResource: README (file:///repo/README.md)\n\nResource: file:///repo/context.txt\ncontext",
    );
  });

  it("rejects unsupported and empty prompt blocks", () => {
    expect(() => promptToText([])).toThrow("Prompt must contain text or a resource link");
    expect(() =>
      promptToText([{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]),
    ).toThrow("Image prompts are not supported");
  });

  it("maps agent output, tools and usage", () => {
    expect(agentEventToUpdate({ type: "stream_text", text: "hello" }, "/repo", 1000)).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello" },
    });
    expect(
      agentEventToUpdate(
        {
          type: "tool_use",
          toolName: "ReadFile",
          toolId: "tool-1",
          args: { file_path: "src/index.ts" },
        },
        "/repo",
        1000,
      ),
    ).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      kind: "read",
      locations: [{ path: "/repo/src/index.ts" }],
    });
    expect(
      agentEventToUpdate(
        {
          type: "usage",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            cacheReadInputTokens: 3,
            cacheCreationInputTokens: 4,
          },
        },
        "/repo",
        1000,
      ),
    ).toEqual({ sessionUpdate: "usage_update", used: 17, size: 1000 });
  });

  it("accumulates usage and maps stop reasons", () => {
    const usage = addUsage(emptyUsage(), {
      type: "usage",
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 4,
      },
    });
    expect(usage).toEqual({
      totalTokens: 19,
      inputTokens: 10,
      outputTokens: 2,
      cachedReadTokens: 3,
      cachedWriteTokens: 4,
    });
    expect(stopReason("interrupted")).toBe("cancelled");
    expect(stopReason("max_tokens")).toBe("max_tokens");
    expect(stopReason("tool_use")).toBe("end_turn");
    expect(toolKind("EditFile")).toBe("edit");
    expect(toolKind("Grep")).toBe("search");
  });

  it("replays persisted messages and tool calls", () => {
    const messages: SessionMessage[] = [
      { role: "user", content: "hello", timestamp: 1 },
      {
        role: "assistant",
        content: "reading",
        timestamp: 2,
        tool_uses: [
          {
            tool_use_id: "tool-1",
            tool_name: "ReadFile",
            arguments: { file_path: "README.md" },
          },
        ],
      },
      {
        role: "user",
        content: "",
        timestamp: 3,
        tool_results: [{ tool_use_id: "tool-1", content: "done" }],
      },
    ];

    expect([...historyNotifications("session-1", messages, "/repo")]).toMatchObject([
      { update: { sessionUpdate: "user_message_chunk" } },
      { update: { sessionUpdate: "agent_message_chunk" } },
      { update: { sessionUpdate: "tool_call", toolCallId: "tool-1" } },
      { update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1" } },
    ]);
  });
});
