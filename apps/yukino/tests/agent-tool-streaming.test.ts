import { describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "@yukino.js/agent/events.js";
import { Agent } from "@yukino.js/agent";
import { ConversationManager } from "@yukino.js/conversation";
import type { ToolUseBlock } from "@yukino.js/conversation";
import { HookEngine } from "@yukino.js/hooks";
import type { LLMClient } from "@yukino.js/llm/client.js";
import type { StreamEvent } from "@yukino.js/llm/events.js";
import { PermissionChecker } from "@yukino.js/permissions";
import { AgentTool } from "@yukino.js/subagent/agent-tool.js";
import { TaskList } from "@yukino.js/todo";
import { TodoWriteTool } from "@yukino.js/todo/tools.js";
import { ToolRegistry } from "@yukino.js/tools/registry.js";
import type { Tool, ToolResult } from "@yukino.js/tools/types.js";
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
function fixture(
  tools: Tool[],
  abortSignal?: AbortSignal,
  hookEngine?: HookEngine,
  calls: ToolUseBlock[] = tools.map((tool) => ({
    toolUseId: tool.name,
    toolName: tool.name,
    arguments: {},
  })),
) {
  const conversation = new ConversationManager();
  conversation.addUserMessage("run tools");
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.register(tool);
  }
  let requests = 0;
  const client: LLMClient = {
    setSystemPrompt: vi.fn(),
    async *stream() {
      if (requests++ === 0) {
        for (const call of calls) {
          yield {
            type: "tool_call_complete",
            toolId: call.toolUseId,
            toolName: call.toolName,
            arguments: call.arguments,
          };
        }
      }
      await Promise.resolve();
      yield end;
    },
  };
  const agent = new Agent({
    client,
    registry,
    conversation,
    checker: new PermissionChecker(process.cwd(), "bypassPermissions"),
    cwd: process.cwd(),
    abortSignal,
    hookEngine,
  });
  return { iterator: agent.run(), conversation, requests: () => requests };
}
function tool(
  name: string,
  execute: Tool["execute"],
  category: Tool["category"] = "read",
): Tool {
  return {
    name,
    category,
    description: name,
    schema: () => ({
      name,
      description: name,
      input_schema: { type: "object", properties: {} },
    }),
    execute,
  };
}
async function nextResult(iterator: AsyncGenerator<AgentEvent>) {
  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      throw new Error("Agent ended before a tool result");
    }
    if (next.value.type === "tool_result") {
      return next.value;
    }
  }
}
function deferredResult() {
  let release: (result: ToolResult) => void = () => undefined;
  const result = new Promise<ToolResult>((resolve) => {
    release = resolve;
  });
  return { result, release };
}
async function collectEvents(iterator: AsyncGenerator<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of iterator) {
    events.push(event);
  }
  return events;
}
describe("tool completion streaming", () => {
  it.each(["create", "update", "read"])(
    "TodoWrite %s completes while earlier foreground Agents are still running",
    async (operation) => {
      const name = "TodoWrite";
      const slow = deferredResult();
      const tasks = new TaskList();
      const task = tasks
        .write({ todos: [{ subject: "work", description: "" }] })
        .slice(-1)[0];
      const taskTool = new TodoWriteTool(tasks);
      const args =
        operation === "create"
          ? { todos: [{ subject: "next" }] }
          : operation === "update"
            ? { todos: [{ id: task.id, status: "in_progress" }] }
            : {};
      const delegation = new AgentTool(
        process.cwd(),
        new ToolRegistry(),
        async () => (await slow.result).output,
      );
      const { iterator, conversation } = fixture(
        [delegation, taskTool],
        undefined,
        undefined,
        [
          ...["agent-1", "agent-2"].map((toolUseId) => ({
            toolUseId,
            toolName: "Agent",
            arguments: {
              kind: "subagent",
              subagent_type: "general-purpose",
              fork: false,
              prompt: "do work",
              description: "work",
            },
          })),
          { toolUseId: "tracking", toolName: name, arguments: args },
        ],
      );
      const completed = vi.fn();
      const next = nextResult(iterator).then(completed);
      try {
        await vi.waitFor(
          () => {
            expect(completed).toHaveBeenCalledWith(
              expect.objectContaining({
                toolId: "tracking",
                toolName: name,
                isError: false,
              }),
            );
          },
          { timeout: 500 },
        );
        expect(tasks.list()).toHaveLength(operation === "create" ? 2 : 1);
        if (operation === "update") {
          expect(tasks.get(task.id)?.status).toBe("in_progress");
        }
        slow.release({ output: "done", isError: false });
        await collectEvents(iterator);
        expect(
          conversation
            .getMessages()
            .at(-1)
            ?.toolResults?.map((result) => result.toolUseId),
        ).toEqual(["agent-1", "agent-2", "tracking"]);
      } finally {
        slow.release({ output: "done", isError: false });
        await next;
        await iterator.return(undefined);
      }
    },
  );
  it("preserves task creation and dependent update order within a concurrent batch", async () => {
    const tasks = new TaskList();
    const calls = [
      {
        toolName: "TodoWrite",
        arguments: { todos: [{ subject: "first", description: "" }] },
      },
      {
        toolName: "TodoWrite",
        arguments: { todos: [{ subject: "second", description: "" }] },
      },
      {
        toolName: "TodoWrite",
        arguments: { todos: [{ id: "2", blockedBy: ["1"] }] },
      },
      {
        toolName: "TodoWrite",
        arguments: { todos: [{ id: "1", status: "completed" }] },
      },
      {
        toolName: "TodoWrite",
        arguments: { todos: [{ id: "2", status: "in_progress" }] },
      },
    ].map((call, index) => ({
      ...call,
      toolUseId: String(index),
    }));
    const { iterator, conversation } = fixture(
      [new TodoWriteTool(tasks)],
      undefined,
      undefined,
      calls,
    );
    const events = await collectEvents(iterator);
    expect(
      events
        .filter((event) => event.type === "tool_result")
        .map((event) => event.isError),
    ).toEqual([false, false, false, false, false]);
    expect(tasks.get("1")).toMatchObject({
      status: "completed",
      blocks: ["2"],
    });
    expect(tasks.get("2")).toMatchObject({
      status: "in_progress",
      blockedBy: ["1"],
    });
    expect(
      conversation
        .getMessages()
        .at(-1)
        ?.toolResults?.map((result) => result.toolUseId),
    ).toEqual(["0", "1", "2", "3", "4"]);
  });
  it("emits a fast result before a slow call finishes and persists source order", async () => {
    const slow = deferredResult();
    const { iterator, conversation } = fixture([
      tool("Slow", () => slow.result),
      tool("Fast", () => Promise.resolve({ output: "fast", isError: false })),
    ]);
    try {
      expect(await nextResult(iterator)).toMatchObject({
        toolId: "Fast",
        output: "fast",
      });
      expect(
        conversation
          .getMessages()
          .at(-1)
          ?.toolUses?.map((call) => call.toolUseId),
      ).toEqual(["Slow", "Fast"]);
      slow.release({ output: "slow", isError: false });
      expect(await nextResult(iterator)).toMatchObject({
        toolId: "Slow",
        output: "slow",
      });
      await collectEvents(iterator);
      const results = conversation
        .getMessages()
        .find((message) => message.toolResults)?.toolResults;
      expect(
        results?.map((result) => [result.toolUseId, result.content]),
      ).toEqual([
        ["Slow", "slow"],
        ["Fast", "fast"],
      ]);
    } finally {
      slow.release({ output: "slow", isError: false });
      await iterator.return(undefined);
    }
  }, 3000);
  it("emits a sequential result before launching the next mutation", async () => {
    const second = vi.fn(() =>
      Promise.resolve({ output: "second", isError: false }),
    );
    const { iterator } = fixture([
      tool(
        "FirstWrite",
        () => Promise.resolve({ output: "first", isError: false }),
        "write",
      ),
      tool("SecondWrite", second, "write"),
    ]);
    expect(await nextResult(iterator)).toMatchObject({ toolId: "FirstWrite" });
    expect(second).not.toHaveBeenCalled();
    await collectEvents(iterator);
    expect(second).toHaveBeenCalledOnce();
  });
  it("preflights the whole parallel batch before execution and runs post hooks in completion order", async () => {
    const slow = deferredResult();
    const trace: string[] = [];
    const hooks = new HookEngine([]);
    vi.spyOn(hooks, "firePreToolHooks").mockImplementation((name) => {
      trace.push(`pre:${name}`);
      return Promise.resolve({ rejected: false, reason: "" });
    });
    vi.spyOn(hooks, "fire").mockImplementation((event, context) => {
      if (event === "post_tool_use") {
        trace.push(`post:${context.toolName ?? ""}`);
      }
      return Promise.resolve([]);
    });
    const { iterator } = fixture(
      [
        tool("Slow", () => {
          trace.push("run:Slow");
          return slow.result;
        }),
        tool("Fast", () => {
          trace.push("run:Fast");
          return Promise.resolve({ output: "fast", isError: false });
        }),
      ],
      undefined,
      hooks,
    );
    try {
      expect(await nextResult(iterator)).toMatchObject({ toolId: "Fast" });
      expect(trace).toEqual([
        "pre:Slow",
        "pre:Fast",
        "run:Slow",
        "run:Fast",
        "post:Fast",
      ]);
      slow.release({ output: "slow", isError: false });
      await collectEvents(iterator);
      expect(trace.at(-1)).toBe("post:Slow");
    } finally {
      slow.release({ output: "slow", isError: false });
      await iterator.return(undefined);
    }
  }, 3000);
  it("pairs every result on interruption and skips later mutations and provider requests", async () => {
    const slow = deferredResult();
    const controller = new AbortController();
    const write = vi.fn(() =>
      Promise.resolve({ output: "write", isError: false }),
    );
    const { iterator, conversation, requests } = fixture(
      [
        tool("Slow", () => slow.result),
        tool("Fast", () => Promise.resolve({ output: "fast", isError: false })),
        tool("Write", write, "write"),
      ],
      controller.signal,
    );
    try {
      expect(await nextResult(iterator)).toMatchObject({ toolId: "Fast" });
      controller.abort();
      slow.release({ output: "cancelled", isError: true });
      const events: AgentEvent[] = [];
      for await (const event of iterator) {
        events.push(event);
      }
      expect(events.at(-1)).toEqual({
        type: "loop_complete",
        stopReason: "interrupted",
      });
      expect(write).not.toHaveBeenCalled();
      expect(requests()).toBe(1);
      expect(
        conversation
          .getMessages()
          .at(-1)
          ?.toolResults?.map((result) => result.toolUseId),
      ).toEqual(["Slow", "Fast", "Write"]);
    } finally {
      slow.release({ output: "cancelled", isError: true });
      await iterator.return(undefined);
    }
  }, 3000);
});
