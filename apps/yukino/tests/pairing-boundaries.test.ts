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

import type { Message } from "@/conversation/index.js";
import {
  ensureToolPairing,
  INTERRUPTED_TOOL_RESULT,
} from "@/conversation/pairing.js";
import {
  buildAnthropicMessages,
  markLastUserTailForCache,
} from "@/llm/anthropic.js";
import { buildChatCompletionMessages, buildOpenAIInput } from "@/llm/openai.js";

function call(...ids: string[]): Message {
  return {
    role: "assistant",
    content: "",
    toolUses: ids.map((toolUseId) => ({
      toolUseId,
      toolName: "ReadFile",
      arguments: {},
    })),
  };
}

function result(id: string): Message {
  return {
    role: "user",
    content: "",
    toolResults: [{ toolUseId: id, content: `result ${id}`, isError: false }],
  };
}

describe("tool pairing at turn boundaries", () => {
  it("repairs a call before an intervening turn and discards its late duplicate result", () => {
    const late = result("a");
    late.content = "<system-reminder>still relevant</system-reminder>";
    const history: Message[] = [
      call("a"),
      { role: "user", content: "continue" },
      late,
    ];
    const original = structuredClone(history);
    const repaired = ensureToolPairing(history);

    expect(repaired[1].toolResults).toEqual([
      { toolUseId: "a", content: INTERRUPTED_TOOL_RESULT, isError: true },
    ]);
    expect(repaired.slice(2).map((m) => m.content)).toEqual([
      "continue",
      late.content,
    ]);
    expect(repaired.flatMap((m) => m.toolResults ?? [])).toHaveLength(1);
    expect(history).toEqual(original);
    expect(ensureToolPairing(repaired)).toEqual(repaired);
  });

  it("does not use a result preceding its call to resolve that call", () => {
    const repaired = ensureToolPairing([result("a"), call("a")]);
    expect(repaired).toHaveLength(2);
    expect(repaired[0]).toEqual(call("a"));
    expect(repaired[1].toolResults?.[0].isError).toBe(true);
  });

  it("deduplicates results and fills a missing sibling before user content", () => {
    const first = result("a");
    first.content = [
      { type: "text", text: "<system-reminder>note</system-reminder>" },
    ];
    const repaired = ensureToolPairing([call("a", "b"), first, result("a")]);
    expect(repaired).toHaveLength(2);
    expect(repaired[1].content).toEqual(first.content);
    expect(repaired[1].toolResults).toEqual([
      { toolUseId: "a", content: "result a", isError: false },
      { toolUseId: "b", content: INTERRUPTED_TOOL_RESULT, isError: true },
    ]);
  });

  it("keeps parallel results together before rich content for all providers", () => {
    const first = result("a");
    first.toolResults = [
      {
        toolUseId: "a",
        content: "image a",
        isError: false,
        contentBlocks: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "QUJD" },
          },
        ],
      },
    ];
    const second = result("b");
    second.content = "<system-reminder>after tools</system-reminder>";
    const history = [call("a", "b"), first, second];
    const original = structuredClone(history);
    const repaired = ensureToolPairing(history);
    const anthropic = buildAnthropicMessages(repaired);
    expect(anthropic[1].content).toMatchObject([
      { type: "tool_result", tool_use_id: "a" },
      { type: "tool_result", tool_use_id: "b" },
    ]);
    const chat = buildChatCompletionMessages(repaired);
    expect(chat.slice(0, 3).map((m) => m.role)).toEqual([
      "assistant",
      "tool",
      "tool",
    ]);
    const responses = buildOpenAIInput(repaired);
    expect(responses.slice(0, 4).map((m) => m.type)).toEqual([
      "function_call",
      "function_call",
      "function_call_output",
      "function_call_output",
    ]);
    for (const converted of [anthropic, chat, responses]) {
      expect(JSON.stringify(converted)).toContain("QUJD");
      expect(JSON.stringify(converted)).toContain(second.content);
    }
    expect(history).toEqual(original);
    expect(ensureToolPairing(repaired)).toEqual(repaired);
  });
});

describe("Anthropic conversation cache tail", () => {
  it("marks only the latest user tail and preserves the original history", () => {
    const history: Message[] = [];
    for (let i = 0; i < 6; i++) {
      history.push(
        { role: "user", content: `turn ${String(i)}` },
        { role: "assistant", content: "ok" },
      );
    }
    const original = structuredClone(history);
    const messages = buildAnthropicMessages(history);
    markLastUserTailForCache(messages);
    expect(JSON.stringify(messages).match(/cache_control/g)).toHaveLength(1);
    expect(messages[10].content).toEqual([
      { type: "text", text: "turn 5", cache_control: { type: "ephemeral" } },
    ]);
    expect(history).toEqual(original);
  });
});
