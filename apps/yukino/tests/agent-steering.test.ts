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
import type { LLMClient } from "@/llm/client.js";
import type { StreamEvent, UsageInfo } from "@/llm/events.js";
import { PermissionChecker } from "@/permissions/index.js";
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

/** Scripted client that snapshots the conversation it sees on every call. */
class ScriptedClient implements LLMClient {
  calls = 0;
  readonly transcripts: string[][] = [];
  constructor(private scripts: StreamEvent[][]) {}
  setSystemPrompt(_prompt: string): void {
    /** noop */
  }
  async *stream(
    conversationManager: ConversationManager,
  ): AsyncGenerator<StreamEvent> {
    this.transcripts.push(
      conversationManager.getMessages().map((m) => contentToText(m.content)),
    );
    const script = this.scripts[this.calls] ?? [end()];
    this.calls++;
    for (const ev of script) {
      await Promise.resolve();
      yield ev;
    }
  }
  setMaxOutputTokens(_n: number): void {
    /** noop */
  }
}

const echoTool = (onExecute?: () => void): Tool => ({
  name: "Echo",
  description: "echo",
  category: "read",
  schema: () => ({
    name: "Echo",
    description: "echo",
    input_schema: { type: "object", properties: {} },
  }),
  execute: () => {
    onExecute?.();
    return Promise.resolve({ output: "echoed", isError: false });
  },
});

function makeAgent(
  client: LLMClient,
  tool?: Tool,
): { agent: Agent; conversation: ConversationManager } {
  const conversation = new ConversationManager();
  conversation.addUserMessage("hi");
  const registry = new ToolRegistry();
  if (tool) {
    registry.register(tool);
  }
  const agent = new Agent({
    client,
    registry,
    checker: new PermissionChecker(process.cwd(), "bypassPermissions"),
    conversation,
    workDir: process.cwd(),
  });
  return { agent, conversation };
}

async function collect(agent: Agent): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of agent.run()) {
    events.push(e);
  }
  return events;
}

describe("Agent steering", () => {
  it("delivers queued steering when the model stops without tool calls, keeping the run alive", async () => {
    const client = new ScriptedClient([
      [{ type: "text_delta", text: "first" }, end()],
      [{ type: "text_delta", text: "second" }, end()],
    ]);
    const { agent, conversation } = makeAgent(client);
    agent.steer("steered note");

    const events = await collect(agent);

    expect(
      events.some(
        (e) => e.type === "steering_delivered" && e.text === "steered note",
      ),
    ).toBe(true);

    const messages = conversation.getMessages();
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(contentToText(messages[2]?.content)).toBe("steered note");
    expect(contentToText(messages[3]?.content)).toBe("second");

    // The follow-up LLM call must see the injected message.
    expect(client.transcripts[1]).toContain("steered note");

    const lc = events.find((e) => e.type === "loop_complete");
    expect(lc?.type === "loop_complete" && lc.stopReason).toBe("end_turn");
  });

  it("delivers mid-run steering after tool results and before the next LLM call", async () => {
    let inFlight: Agent | null = null;
    const tool = echoTool(() => {
      inFlight?.steer("mid-run correction");
    });
    const client = new ScriptedClient([
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
    const { agent, conversation } = makeAgent(client, tool);
    inFlight = agent;

    const events = await collect(agent);

    expect(
      events.some(
        (e) =>
          e.type === "steering_delivered" && e.text === "mid-run correction",
      ),
    ).toBe(true);

    const messages = conversation.getMessages();
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "user",
      "assistant",
    ]);
    expect(contentToText(messages[3]?.content)).toBe("mid-run correction");
    expect(contentToText(messages[4]?.content)).toBe("done");

    // The follow-up LLM call must see the injected message.
    expect(client.transcripts[1]).toContain("mid-run correction");

    const lc = events.find((e) => e.type === "loop_complete");
    expect(lc?.type === "loop_complete" && lc.stopReason).toBe("end_turn");
  });

  it("does not deliver steering removed before the boundary", async () => {
    const client = new ScriptedClient([
      [{ type: "text_delta", text: "hi" }, end()],
    ]);
    const { agent } = makeAgent(client);
    agent.steer("recalled");
    expect(agent.removeSteering("recalled")).toBe(true);

    const events = await collect(agent);

    expect(events.some((e) => e.type === "steering_delivered")).toBe(false);
    expect(client.calls).toBe(1);
  });
});
