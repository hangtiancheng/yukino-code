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

import { Agent } from "@/agent/index.js";
import { ConversationManager } from "@/conversation/index.js";
import type { LLMClient } from "@/llm/client.js";
import type { StreamEvent, UsageInfo } from "@/llm/events.js";
import type { RecallResult } from "@/memory/manager.js";
import { PermissionChecker } from "@/permissions/index.js";
import { ToolRegistry } from "@/tools/registry.js";
import type { Tool } from "@/tools/types.js";

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

const REMINDER = "## Memory: a.md";

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

const echoTool: Tool = {
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

/** Creates an already-settled recall promise, simulating a prefetch that completed during the main LLM call. */
function settledRecall(): Promise<RecallResult> {
  return Promise.resolve({ reminder: REMINDER, paths: ["/mem/a.md"] });
}

async function run(scripts: StreamEvent[][], withTool: boolean) {
  const conv = new ConversationManager();
  conv.addUserMessage("hi");
  const registry = new ToolRegistry();
  if (withTool) {
    registry.register(echoTool);
  }
  const surfaced: string[] = [];
  const agent = new Agent({
    client: new MockClient(scripts),
    registry,
    checker: new PermissionChecker(process.cwd(), "bypassPermissions"),
    conversation: conv,
    workDir: process.cwd(),
    memoryRecallPromise: settledRecall(),
    onMemoriesSurfaced: (paths) => surfaced.push(...paths),
  });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of agent.run()) {
    // drain
  }
  const injected = conv
    .getMessages()
    .some((m) => typeof m.content === "string" && m.content.includes(REMINDER));
  return { injected, surfaced };
}

describe("memory recall wiring", () => {
  it("turn with tool calls: recall result is injected after tool results and marked as surfaced", async () => {
    const { injected, surfaced } = await run(
      [
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
      ],
      true,
    );
    expect(injected).toBe(true);
    expect(surfaced).toEqual(["/mem/a.md"]);
  });

  it("turn without tool calls: recall result is not consumed and memories are not marked as surfaced", async () => {
    const { injected, surfaced } = await run(
      [[{ type: "text_delta", text: "plain" }, end()]],
      false,
    );
    expect(injected).toBe(false);
    expect(surfaced).toEqual([]);
  });
});
