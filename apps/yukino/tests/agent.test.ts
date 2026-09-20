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

import { describe, it, expect } from "vitest";

import type { AgentEvent } from "@/agent/events.js";
import { Agent } from "@/agent/index.js";
import { ConversationManager } from "@/conversation/index.js";
import { HookEngine } from "@/hooks/index.js";
import type { LLMClient } from "@/llm/client.js";
import type { StreamEvent, UsageInfo } from "@/llm/events.js";
import { PermissionChecker } from "@/permissions/index.js";
import { ExitPlanModeTool } from "@/tools/exit-plan-mode.js";
import { ToolRegistry } from "@/tools/registry.js";
import type { Tool } from "@/tools/types.js";
import { contentToText } from "@/utils/index.js";

const USAGE: UsageInfo = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};
const end = (reason = "end_turn"): StreamEvent => ({
  type: "stream_end",
  stopReason: reason,
  usage: USAGE,
});

class MockClient implements LLMClient {
  calls = 0;
  maxTokensSet: number | null = null;
  constructor(private scripts: StreamEvent[][]) {}
  setSystemPrompt(_prompt: string): void {
    /** noop */
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async *stream(): AsyncGenerator<StreamEvent> {
    const script = this.scripts[this.calls++] ?? [end()];
    for (const ev of script) {
      yield ev;
    }
  }
  setMaxOutputTokens(n: number): void {
    this.maxTokensSet = n;
  }
}

const echoTool: Tool = {
  name: "Echo",
  description: "echo",
  category: "read",
  schema: () => ({
    name: "Echo",
    description: "echo",
    input_schema: { type: "object", properties: {} },
  }),
  // eslint-disable-next-line @typescript-eslint/require-await
  execute: async () => ({ output: "echoed", isError: false }),
};

async function runAgent(
  client: LLMClient,
  opts: {
    tool?: Tool;
    hookEngine?: HookEngine;
    abortSignal?: AbortSignal;
    maxOutput?: number;
  } = {},
): Promise<{ events: AgentEvent[]; conversation: ConversationManager }> {
  const conversation = new ConversationManager();
  conversation.addUserMessage("hi");
  const registry = new ToolRegistry();
  if (opts.tool) {
    registry.register(opts.tool);
  }
  const agent = new Agent({
    client,
    registry,
    checker: new PermissionChecker(process.cwd(), "bypassPermissions"),
    conversation: conversation,
    workDir: process.cwd(),
    hookEngine: opts.hookEngine,
    abortSignal: opts.abortSignal,
    maxOutput: opts.maxOutput,
  });
  const events: AgentEvent[] = [];
  for await (const e of agent.run()) {
    events.push(e);
  }
  return { events, conversation };
}

describe("Agent loop", () => {
  it("streams text and completes on end_turn", async () => {
    const client = new MockClient([[{ type: "text_delta", text: "hello" }, end()]]);
    const { events, conversation } = await runAgent(client);

    expect(events.some((e) => e.type === "stream_text" && e.text === "hello")).toBe(true);
    const lc = events.find((e) => e.type === "loop_complete");
    expect(lc?.type === "loop_complete" && lc.stopReason).toBe("end_turn");

    const last = conversation.getMessages().at(-1);
    expect(last?.role).toBe("assistant");
    expect(last?.content).toBe("hello");
  });

  it("executes a tool turn then completes", async () => {
    const client = new MockClient([
      [
        {
          type: "tool_call_complete",
          toolId: "t1",
          toolName: "Echo",
          arguments: {},
        },
        end("tool_use"),
      ],
      [{ type: "text_delta", text: "done" }, end()],
    ]);
    const { events } = await runAgent(client, { tool: echoTool });

    expect(events.some((e) => e.type === "tool_use" && e.toolName === "Echo")).toBe(true);
    const tr = events.find((e) => e.type === "tool_result");
    expect(tr?.type === "tool_result" && tr.output).toBe("echoed");
    expect(tr?.type === "tool_result" && tr.isError).toBe(false);
    expect(events.some((e) => e.type === "turn_complete")).toBe(true);
    expect(events.some((e) => e.type === "loop_complete")).toBe(true);
  });

  it("escalates output ceiling and retries on max_tokens", async () => {
    const client = new MockClient([
      [{ type: "text_delta", text: "partial" }, end("max_tokens")],
      [{ type: "text_delta", text: " done" }, end()],
    ]);
    const { events } = await runAgent(client, { maxOutput: 8192 });

    expect(events.some((e) => e.type === "retry" && e.reason.includes("max_tokens"))).toBe(true);
    expect(client.maxTokensSet).toBe(64000);
    expect(events.some((e) => e.type === "loop_complete")).toBe(true);
  });

  it("returns an error result for unknown tools and keeps looping", async () => {
    const unknownTurn = (id: string): StreamEvent[] => [
      {
        type: "tool_call_complete",
        toolId: id,
        toolName: "Nope",
        arguments: {},
      },
      end("tool_use"),
    ];
    // After 3 consecutive wrong tool guesses, switch to plain text on round 4 and let the model handle the loop termination.
    const client = new MockClient([
      unknownTurn("x1"),
      unknownTurn("x2"),
      unknownTurn("x3"),
      [{ type: "text_delta", text: "That tool does not exist." }, end()],
    ]);
    const { events } = await runAgent(client); // no Echo registered → Nope is unknown

    expect(events.some((e) => e.type === "error")).toBe(false);
    const results = events.filter((e) => e.type === "tool_result");
    expect(results.length).toBe(3);
    expect(results.every((e) => e.type === "tool_result" && e.isError)).toBe(true);
    expect(events.some((e) => e.type === "loop_complete")).toBe(true);
  });

  it("propagates cache token fields from stream_end through the usage event", async () => {
    const usageWithCache: UsageInfo = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 1000,
      cacheCreationInputTokens: 200,
    };
    const client = new MockClient([
      [
        { type: "text_delta", text: "hi" },
        { type: "stream_end", stopReason: "end_turn", usage: usageWithCache },
      ],
    ]);
    const { events } = await runAgent(client);

    const usage = events.find((e) => e.type === "usage");
    expect(usage?.type === "usage" && usage.usage.cacheReadInputTokens).toBe(1000);
    expect(usage?.type === "usage" && usage.usage.cacheCreationInputTokens).toBe(200);
  });

  it("aborting during a tool call interrupts it and ends the loop without another LLM call", async () => {
    const controller = new AbortController();
    // Resolves only when the abort signal reaches the tool context — proves
    // executeBatch wires abortSignal through to tool execution.
    const interruptibleTool: Tool = {
      name: "Echo",
      description: "echo",
      category: "read",
      schema: () => ({
        name: "Echo",
        description: "echo",
        input_schema: { type: "object", properties: {} },
      }),
      execute: (ctx) =>
        new Promise((resolve) => {
          ctx.abortSignal?.addEventListener("abort", () => {
            resolve({ output: "Error: command interrupted", isError: true });
          });
        }),
    };
    const client = new MockClient([
      [
        {
          type: "tool_call_complete",
          toolId: "t1",
          toolName: "Echo",
          arguments: {},
        },
        end("tool_use"),
      ],
      [{ type: "text_delta", text: "should never stream" }, end()],
    ]);
    setTimeout(() => {
      controller.abort();
    }, 20);
    const { events, conversation } = await runAgent(client, {
      tool: interruptibleTool,
      abortSignal: controller.signal,
    });

    const tr = events.find((e) => e.type === "tool_result");
    expect(tr?.type === "tool_result" && tr.isError).toBe(true);
    const lc = events.find((e) => e.type === "loop_complete");
    expect(lc?.type === "loop_complete" && lc.stopReason).toBe("interrupted");
    // No second LLM call after the interrupted tool batch.
    expect(client.calls).toBe(1);
    // The interrupted result is still recorded so tool_use stays paired.
    expect(conversation.getMessages().at(-1)?.toolResults?.length).toBe(1);
  });

  it("keeps looping when ExitPlanMode errors outside plan mode", async () => {
    const exitPlan = new ExitPlanModeTool();
    exitPlan.isPlanMode = () => false;
    const client = new MockClient([
      [
        {
          type: "tool_call_complete",
          toolId: "p1",
          toolName: "ExitPlanMode",
          arguments: {},
        },
        end("tool_use"),
      ],
      [{ type: "text_delta", text: "recovered" }, end()],
    ]);
    const { events, conversation } = await runAgent(client, { tool: exitPlan });

    const tr = events.find((e) => e.type === "tool_result");
    expect(tr?.type === "tool_result" && tr.isError).toBe(true);
    expect(tr?.type === "tool_result" && tr.output).toContain("not in plan mode");
    // The errored call must not end the loop: the model gets a second turn to self-correct.
    expect(client.calls).toBe(2);
    expect(
      conversation.getMessages().some((m) => contentToText(m.content).includes("recovered")),
    ).toBe(true);
  });

  it("ends the loop when ExitPlanMode succeeds", async () => {
    const exitPlan = new ExitPlanModeTool();
    exitPlan.isPlanMode = () => true;
    exitPlan.planExists = () => true;
    const client = new MockClient([
      [
        {
          type: "tool_call_complete",
          toolId: "p1",
          toolName: "ExitPlanMode",
          arguments: {},
        },
        end("tool_use"),
      ],
    ]);
    const { events, conversation } = await runAgent(client, { tool: exitPlan });

    const tr = events.find((e) => e.type === "tool_result");
    expect(tr?.type === "tool_result" && tr.isError).toBe(false);
    expect(client.calls).toBe(1);
    const lc = events.find((e) => e.type === "loop_complete");
    expect(lc?.type === "loop_complete" && lc.stopReason).toBe("end_turn");
    expect(conversation.getMessages().at(-1)?.toolResults?.length).toBe(1);
  });

  it("surfaces lifecycle-hook output as a system reminder on the next turn", async () => {
    const hookEngine = new HookEngine([
      {
        event: "turn_start",
        action: { type: "prompt", prompt: "REMINDER_NOTE" },
      },
    ]);
    const client = new MockClient([
      [
        {
          type: "tool_call_complete",
          toolId: "t1",
          toolName: "Echo",
          arguments: {},
        },
        end("tool_use"),
      ],
      [{ type: "text_delta", text: "done" }, end()],
    ]);
    const { conversation } = await runAgent(client, {
      tool: echoTool,
      hookEngine,
    });

    expect(
      conversation.getMessages().some((m) => contentToText(m.content).includes("REMINDER_NOTE")),
    ).toBe(true);
  });
});
