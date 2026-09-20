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

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderConfig } from "@/config/index.js";
import { ConversationManager } from "@/conversation/index.js";
import { AnthropicClient } from "@/llm/anthropic.js";
import type { LLMClient } from "@/llm/client.js";
import { ContextTooLongError, LLMError, NetworkError, RateLimitError } from "@/llm/errors.js";
import type { StreamEvent } from "@/llm/events.js";
import { OpenAIClient, OpenAICompatClient } from "@/llm/openai.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function config(protocol: ProviderConfig["protocol"]): ProviderConfig {
  return {
    name: "test",
    protocol,
    base_url: "https://example.invalid",
    api_key: "test",
    model: "test",
  };
}

function mockStream(events: { type: string; [key: string]: unknown }[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(
          events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    ),
  );
}

async function collect(client: LLMClient, events: StreamEvent[] = []): Promise<StreamEvent[]> {
  const conversation = new ConversationManager();
  conversation.addUserMessage("hello");
  for await (const event of client.stream(conversation, [])) {
    events.push(event);
  }
  return events;
}

const usage = {
  input_tokens: 20,
  output_tokens: 7,
  total_tokens: 27,
  input_tokens_details: { cached_tokens: 5 },
  output_tokens_details: { reasoning_tokens: 0 },
};

describe("Responses terminal events", () => {
  it("emits native computer calls as ComputerUse invocations", async () => {
    const item = {
      type: "computer_call",
      id: "item_1",
      call_id: "call_1",
      status: "in_progress",
      actions: [
        { type: "move", x: 10, y: 20, keys: null },
        { type: "scroll", x: 10, y: 20, scroll_x: 30, scroll_y: -40, keys: ["SHIFT"] },
      ],
      pending_safety_checks: [{ id: "check_1", code: "navigation", message: "Review navigation" }],
    };
    mockStream([
      { type: "response.output_item.added", sequence_number: 0, output_index: 0, item },
      { type: "response.output_item.done", sequence_number: 1, output_index: 0, item },
      {
        type: "response.completed",
        sequence_number: 2,
        response: { id: "resp_test", status: "completed", usage },
      },
    ]);

    const events = await collect(new OpenAIClient(config("openai"), "system"));
    expect(events[0]).toEqual({
      type: "tool_call_start",
      toolName: "ComputerUse",
      toolId: "call_1",
    });
    expect(events[1]).toEqual({
      type: "tool_call_complete",
      toolName: "ComputerUse",
      toolId: "call_1",
      providerItemId: "item_1",
      arguments: {
        actions: [
          { type: "move", x: 10, y: 20 },
          { type: "scroll", x: 10, y: 20, scrollX: 30, scrollY: -40, keys: ["SHIFT"] },
        ],
        pendingSafetyChecks: [{ id: "check_1", code: "navigation", message: "Review navigation" }],
        status: "in_progress",
      },
    });
  });

  it.each(["response.completed", "response.incomplete"])(
    "finalizes %s with usage",
    async (type) => {
      mockStream([
        {
          type,
          sequence_number: 0,
          response: {
            id: "resp_test",
            status: type === "response.completed" ? "completed" : "incomplete",
            incomplete_details:
              type === "response.incomplete" ? { reason: "max_output_tokens" } : null,
            usage,
          },
        },
      ]);
      const events = await collect(new OpenAIClient(config("openai"), "system"));
      expect(events).toEqual([
        {
          type: "stream_end",
          stopReason: type === "response.completed" ? "end_turn" : "max_tokens",
          usage: {
            inputTokens: 15,
            outputTokens: 7,
            cacheReadInputTokens: 5,
            cacheCreationInputTokens: 0,
          },
        },
      ]);
    },
  );

  it("defaults absent cache details to zero", async () => {
    mockStream([
      {
        type: "response.completed",
        sequence_number: 0,
        response: {
          id: "resp_test",
          status: "completed",
          usage: { input_tokens: 20, output_tokens: 7 },
        },
      },
    ]);
    const events = await collect(new OpenAIClient(config("openai"), "system"));
    expect(events[0]).toMatchObject({
      usage: { inputTokens: 20, cacheReadInputTokens: 0 },
    });
  });

  it("reports content filtering instead of a successful end or token retry", async () => {
    mockStream([
      {
        type: "response.incomplete",
        sequence_number: 0,
        response: {
          status: "incomplete",
          incomplete_details: { reason: "content_filter" },
        },
      },
    ]);
    const events: StreamEvent[] = [];
    await expect(collect(new OpenAIClient(config("openai"), "system"), events)).rejects.toThrow(
      "content_filter",
    );
    expect(events).toEqual([]);
  });

  it.each(["server_error", "context_length_exceeded"])(
    "surfaces failed response code %s",
    async (code) => {
      mockStream([
        {
          type: "response.failed",
          sequence_number: 0,
          response: {
            status: "failed",
            error: { code, message: "provider failure" },
          },
        },
      ]);
      await expect(collect(new OpenAIClient(config("openai"), "system"))).rejects.toBeInstanceOf(
        code === "context_length_exceeded" ? ContextTooLongError : LLMError,
      );
    },
  );

  it("surfaces an error event", async () => {
    mockStream([
      {
        type: "error",
        code: "server_error",
        message: "stream failed",
        param: null,
        sequence_number: 0,
      },
    ]);
    await expect(collect(new OpenAIClient(config("openai"), "system"))).rejects.toThrow(
      "stream failed",
    );
  });

  it("rejects an EOF after partial output", async () => {
    mockStream([
      {
        type: "response.output_text.delta",
        delta: "partial",
        sequence_number: 0,
      },
    ]);
    const events: StreamEvent[] = [];
    await expect(
      collect(new OpenAIClient(config("openai"), "system"), events),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(events).toEqual([{ type: "text_delta", text: "partial" }]);
  });
});

describe("Chat Completions terminal boundaries", () => {
  it("rejects EOF without a finish reason", async () => {
    mockStream([
      {
        type: "chunk",
        choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
      },
    ]);
    const events: StreamEvent[] = [];
    await expect(
      collect(new OpenAICompatClient(config("openai-compat"), "system"), events),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(events).toEqual([{ type: "text_delta", text: "partial" }]);
  });

  it("retains a trailing usage-only chunk after the finish reason", async () => {
    mockStream([
      {
        type: "chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
      {
        type: "chunk",
        choices: [],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 7,
          prompt_tokens_details: { cached_tokens: 5 },
        },
      },
    ]);
    const events = await collect(new OpenAICompatClient(config("openai-compat"), "system"));
    expect(events).toEqual([
      {
        type: "stream_end",
        stopReason: "end_turn",
        usage: {
          inputTokens: 15,
          outputTokens: 7,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 0,
        },
      },
    ]);
  });
});

describe("Anthropic thinking replay", () => {
  it("maps the native computer tool name to ComputerUse", async () => {
    mockStream([
      {
        type: "message_start",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "test",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tool_1", name: "computer", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"action":"screenshot"}' },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ]);

    const events = await collect(new AnthropicClient(config("anthropic"), "system"));
    expect(events).toContainEqual({
      type: "tool_call_start",
      toolName: "ComputerUse",
      toolId: "tool_1",
    });
    expect(events).toContainEqual({
      type: "tool_call_complete",
      toolName: "ComputerUse",
      toolId: "tool_1",
      arguments: { action: "screenshot" },
    });
  });

  it("assembles every signature fragment before emitting thinking_complete", async () => {
    mockStream([
      {
        type: "message_start",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "test",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "thought" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "first" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "second" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ]);
    const events = await collect(new AnthropicClient(config("anthropic"), "system"));
    expect(events.find((event) => event.type === "thinking_complete")).toEqual({
      type: "thinking_complete",
      thinking: "thought",
      signature: "firstsecond",
    });
  });
});

describe("provider rate-limit headers", () => {
  it.each(["anthropic", "openai", "openai-compat"] as const)(
    "preserves Retry-After for %s",
    async (protocol) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                error: { type: "rate_limit_error", message: "slow down" },
              }),
              {
                status: 429,
                headers: {
                  "content-type": "application/json",
                  "retry-after": "12",
                  "x-should-retry": "false",
                },
              },
            ),
          ),
        ),
      );
      const client =
        protocol === "anthropic"
          ? new AnthropicClient(config(protocol), "system")
          : protocol === "openai"
            ? new OpenAIClient(config(protocol), "system")
            : new OpenAICompatClient(config(protocol), "system");
      await expect(collect(client)).rejects.toMatchObject({
        name: RateLimitError.name,
        retryAfter: "12",
      });
    },
  );
});
