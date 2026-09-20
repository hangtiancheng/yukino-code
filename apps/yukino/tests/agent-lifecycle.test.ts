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

import type { AgentEvent } from "@/agent/events.js";
import { Agent, type AgentConfig } from "@/agent/index.js";
import { ConversationManager } from "@/conversation/index.js";
import { HookEngine } from "@/hooks/index.js";
import type { LLMClient } from "@/llm/client.js";
import { NetworkError, RateLimitError } from "@/llm/errors.js";
import type { StreamEvent } from "@/llm/events.js";
import { PermissionChecker } from "@/permissions/index.js";
import { ToolRegistry } from "@/tools/registry.js";
import { contentToText } from "@/utils/index.js";

const end: StreamEvent = {
  type: "stream_end",
  stopReason: "end_turn",
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  },
};

function fixture(stream: LLMClient["stream"], options: Partial<AgentConfig> = {}) {
  const conversation = new ConversationManager();
  conversation.addUserMessage("task");
  const config: AgentConfig = {
    client: { stream, setSystemPrompt: vi.fn() },
    conversation,
    registry: new ToolRegistry(),
    checker: new PermissionChecker(process.cwd(), "bypassPermissions"),
    workDir: process.cwd(),
    ...options,
  };
  return config;
}

async function collect(config: AgentConfig): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of new Agent(config).run()) {
    events.push(event);
  }
  return events;
}

afterEach(() => vi.useRealTimers());

describe("agent lifecycle and retry boundaries", () => {
  it("keeps partial text after a broken stream without executing its pending tools", async () => {
    const config = fixture(async function* () {
      await Promise.resolve();
      yield { type: "text_delta", text: "Partial evidence" };
      yield {
        type: "tool_call_complete",
        toolId: "pending",
        toolName: "WriteFile",
        arguments: {},
      };
      throw new NetworkError("stream ended early");
    });
    const events = await collect(config);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: "stream ended early" },
    });
    expect(config.conversation.getMessages().at(-1)?.content).toBe("Partial evidence");
    expect(config.conversation.getMessages().at(-1)?.toolUses ?? []).toEqual([]);
  });

  it("injects pre-send output before the first request and ends a text-only turn", async () => {
    const engine = new HookEngine([
      {
        event: "pre_send",
        action: { type: "prompt", prompt: "CURRENT_REQUEST_NOTE" },
      },
      { event: "turn_end", action: { type: "agent", prompt: "end" } },
    ]);
    const finished = vi.fn(() => Promise.resolve(""));
    engine.agentRunner = finished;
    const config = fixture(
      async function* (conversation) {
        await Promise.resolve();
        expect(
          conversation
            .getMessages()
            .some((m) => contentToText(m.content).includes("CURRENT_REQUEST_NOTE")),
        ).toBe(true);
        yield { type: "text_delta", text: "done" };
        yield end;
      },
      { hookEngine: engine },
    );
    const setSystemPrompt = vi.spyOn(config.client, "setSystemPrompt");
    await collect(config);
    expect(finished).toHaveBeenCalledTimes(1);
    expect(setSystemPrompt).not.toHaveBeenCalled();
  });

  it("pairs tool calls when an approval callback rejects", async () => {
    let calls = 0;
    const config = fixture(
      async function* () {
        await Promise.resolve();
        if (calls++ === 0) {
          yield {
            type: "tool_call_complete",
            toolId: "write",
            toolName: "WriteFile",
            arguments: {},
          };
        }
        yield end;
      },
      { onPermissionRequest: () => Promise.reject(new Error("dialog closed")) },
    );
    vi.spyOn(config.checker, "check").mockReturnValue({
      effect: "ask",
      reason: "approval",
    });
    const execute = vi.fn(() => Promise.resolve({ output: "written", isError: false }));
    config.registry.register({
      name: "WriteFile",
      description: "write",
      category: "write",
      execute,
      schema: () => ({
        name: "WriteFile",
        description: "write",
        input_schema: { type: "object", properties: {} },
      }),
    });
    const events = await collect(config);
    expect(execute).not.toHaveBeenCalled();
    const result = events.find((event) => event.type === "tool_result");
    expect(result).toMatchObject({
      type: "tool_result",
      toolId: "write",
      isError: true,
    });
    expect(result?.type === "tool_result" ? result.output : "").toContain("dialog closed");
    expect(config.conversation.getMessages().flatMap((m) => m.toolResults ?? [])).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("preserves file arguments for post-tool hook conditions", async () => {
    const engine = new HookEngine([
      {
        event: "post_tool_use",
        condition: 'file_path =* "src/**/*.ts"',
        action: { type: "prompt", prompt: "CHECK_TYPES" },
      },
    ]);
    let calls = 0;
    const config = fixture(
      async function* () {
        await Promise.resolve();
        if (calls++ === 0) {
          yield {
            type: "tool_call_complete",
            toolId: "read",
            toolName: "ReadFile",
            arguments: { file_path: "src/a.ts" },
          };
        }
        yield end;
      },
      { hookEngine: engine },
    );
    config.registry.register({
      name: "ReadFile",
      description: "read",
      category: "read",
      execute: () => Promise.resolve({ output: "file", isError: false }),
      schema: () => ({
        name: "ReadFile",
        description: "read",
        input_schema: { type: "object", properties: {} },
      }),
    });
    await collect(config);
    expect(
      config.conversation
        .getMessages()
        .some((m) => contentToText(m.content).includes("CHECK_TYPES")),
    ).toBe(true);
  });

  it("stops persistent rate limits after three retries and balances turn hooks", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const engine = new HookEngine(
      ["turn_start", "turn_end"].map((event) => ({
        event,
        action: { type: "agent", prompt: event },
      })),
    );
    const hookCalls: string[] = [];
    engine.agentRunner = (prompt) => {
      hookCalls.push(prompt);
      return Promise.resolve("");
    };
    const config = fixture(
      async function* () {
        await Promise.resolve();
        calls++;
        yield* [];
        throw new RateLimitError("quota exhausted", "0");
      },
      { hookEngine: engine },
    );
    const running = collect(config);
    await vi.runAllTimersAsync();
    const events = await running;
    expect(calls).toBe(4);
    expect(events.filter((e) => e.type === "retry")).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: "quota exhausted" },
    });
    expect(hookCalls).toEqual(Array.from({ length: 4 }, () => ["turn_start", "turn_end"]).flat());
  });

  it.each([
    ["0.25", 250],
    ["Sat, 12 Sep 2026 08:00:02 GMT", 2000],
    ["999999999999999", 60000],
    ["-1", 5000],
    ["1oops", 5000],
  ])("handles Retry-After %s without timer overflow", async (header, delay) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T08:00:00Z"));
    let calls = 0;
    const config = fixture(async function* () {
      await Promise.resolve();
      if (calls++ === 0) {
        throw new RateLimitError("limited", header);
      }
      yield end;
    });
    const running = collect(config);
    await vi.runAllTimersAsync();
    const events = await running;
    expect(events).toContainEqual({
      type: "retry",
      reason: "rate limited",
      delay,
    });
    expect(calls).toBe(2);
  });
});
