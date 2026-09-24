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

// Injection timing for the deferred-tool reminder, exercised through the real agent loop.
//
// The reminder is pushed into history and stays in context, so re-injecting identical
// content every turn just wastes window space: ~60 MCP tools produce a 500+ token list,
// which adds up to 20k+ tokens over 40 turns.
//
// Expected behavior: injected once across a multi-turn tool-call session; re-injected
// when the pool changes; re-injected after history is compacted.
import { describe, it, expect } from "vitest";

import { Agent } from "@/agent/index.js";
import { ConversationManager } from "@/conversation/index.js";
import type { LLMClient } from "@/llm/client.js";
import type { StreamEvent, UsageInfo } from "@/llm/events.js";
import { PermissionChecker } from "@/permissions/index.js";
import { ToolRegistry } from "@/tools/registry.js";
import type { Tool } from "@/tools/types.js";
import { contentToText } from "@/utils/index.js";

const MARKER = "The following deferred tools are available via ToolSearch.";
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
  constructor(private scripts: StreamEvent[][]) {}
  setSystemPrompt() {
    /** noop */
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async *stream(): AsyncGenerator<StreamEvent> {
    const script = this.scripts[this.calls++] ?? [end()];
    for (const ev of script) {
      yield ev;
    }
  }
  setMaxOutputTokens(): void {
    /** noop */
  }
}

const noopTool: Tool = {
  name: "Echo",
  description: "echo",
  category: "read",
  schema: () => ({
    name: "Echo",
    description: "echo",
    input_schema: { type: "object", properties: {} },
  }),
  execute: () => Promise.resolve({ output: "echoed", isError: false }),
};

function deferredStub(name: string): Tool {
  return {
    name,
    description: name,
    category: "read",
    deferred: true,
    schema: () => ({
      name,
      description: "",
      input_schema: { type: "object", properties: {} },
    }),
    execute: () => Promise.resolve({ output: "ok", isError: false }),
  };
}

// Script for a single tool-call turn
const toolTurn = (id: string): StreamEvent[] => [
  { type: "tool_call_start", toolName: "Echo", toolId: id },
  { type: "tool_call_complete", toolId: id, toolName: "Echo", arguments: {} },
  end("tool_use"),
];

function makeAgent(
  client: LLMClient,
  registry: ToolRegistry,
  conv: ConversationManager,
): Agent {
  return new Agent({
    client,
    registry,
    checker: new PermissionChecker(process.cwd(), "bypassPermissions"),
    conversation: conv,
    workDir: process.cwd(),
  });
}

function count(conv: ConversationManager): number {
  return conv
    .getMessages()
    .filter(
      (m) => m.role === "user" && contentToText(m.content).includes(MARKER),
    ).length;
}

async function drain(agent: Agent): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of agent.run()) {
    // Only side effects on the conversation matter
  }
}

describe("deferred tool reminder", () => {
  it("is injected only once across four turns", async () => {
    // Three tool-call turns + one final turn, four iterations total
    const client = new MockClient([
      toolTurn("t1"),
      toolTurn("t2"),
      toolTurn("t3"),
      [{ type: "text_delta", text: "done" }, end()],
    ]);
    const registry = new ToolRegistry();
    registry.register(noopTool);
    registry.register(deferredStub("mcp__linear__create_issue"));
    registry.register(deferredStub("mcp__sentry__resolve_issue"));

    const conv = new ConversationManager();
    conv.addUserMessage("do three things");
    await drain(makeAgent(client, registry, conv));

    expect(client.calls).toBe(4);
    expect(count(conv)).toBe(1);
  });

  it("re-injects when the tool pool changes", async () => {
    const registry = new ToolRegistry();
    registry.register(deferredStub("mcp__linear__create_issue"));
    const conv = new ConversationManager();

    const c1 = new MockClient([[{ type: "text_delta", text: "one" }, end()]]);
    conv.addUserMessage("first turn");
    await drain(makeAgent(c1, registry, conv));
    expect(count(conv)).toBe(1);

    // MCP server connects late, adding a tool to the pool
    registry.register(deferredStub("mcp__infra__scale_service"));
    const c2 = new MockClient([[{ type: "text_delta", text: "two" }, end()]]);
    conv.addUserMessage("second turn");
    await drain(makeAgent(c2, registry, conv));
    expect(count(conv)).toBe(2);
  });

  it("re-announces after history is compacted", async () => {
    const registry = new ToolRegistry();
    registry.register(deferredStub("mcp__linear__create_issue"));
    const conv = new ConversationManager();

    const c1 = new MockClient([[{ type: "text_delta", text: "one" }, end()]]);
    conv.addUserMessage("first turn");
    await drain(makeAgent(c1, registry, conv));
    expect(count(conv)).toBe(1);

    // Simulate compaction: history is collapsed into a summary, removing the reminder
    conv.truncateTo(0);
    conv.addUserMessage("summary of earlier conversation");

    const c2 = new MockClient([[{ type: "text_delta", text: "two" }, end()]]);
    await drain(makeAgent(c2, registry, conv));
    expect(count(conv)).toBe(1);
  });

  it("returns deferred tool names in stable lexicographic order", () => {
    const registry = new ToolRegistry();
    for (const n of ["mcp__z__b", "mcp__a__c", "mcp__m__a"]) {
      registry.register(deferredStub(n));
    }
    const want = ["mcp__a__c", "mcp__m__a", "mcp__z__b"];
    expect(registry.getDeferredToolNames()).toEqual(want);
    expect(registry.getDeferredToolNames()).toEqual(want);
  });

  it("injects nothing when there are no deferred tools", async () => {
    const client = new MockClient([
      [{ type: "text_delta", text: "hi" }, end()],
    ]);
    const conv = new ConversationManager();
    conv.addUserMessage("hi");
    await drain(makeAgent(client, new ToolRegistry(), conv));
    expect(count(conv)).toBe(0);
  });
});
