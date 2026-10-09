import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "@/agent/events.js";
import { Agent } from "@/agent/index.js";
import { ConversationManager } from "@/conversation/index.js";
import { HookEngine } from "@/hooks/index.js";
import type { LLMClient, LLMStreamOptions } from "@/llm/client.js";
import type { StreamEvent, UsageInfo } from "@/llm/events.js";
import { PermissionChecker } from "@/permissions/index.js";
import { getOrCreatePlanPath } from "@/plan-file/index.js";
import { ExitPlanModeTool } from "@/tools/exit-plan-mode.js";
import { ToolRegistry } from "@/tools/registry.js";
import type { Tool } from "@/tools/types.js";
import type { ProviderToolSchema } from "@/tools/types.js";
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
  outputLimits: number[] = [];
  constructor(private scripts: StreamEvent[][]) {}
  setSystemPrompt(_prompt: string): void {
    /** noop */
  }
  async *stream(
    _conversation: ConversationManager,
    _tools: ProviderToolSchema[],
    _signal?: AbortSignal,
    options?: LLMStreamOptions,
  ): AsyncGenerator<StreamEvent> {
    this.outputLimits.push(options?.maxOutputTokens ?? 8192);
    const script = this.scripts[this.calls++] ?? [end()];
    for (const ev of script) {
      await Promise.resolve();
      yield ev;
    }
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

async function runAgent(
  client: LLMClient,
  opts: {
    tool?: Tool;
    hookEngine?: HookEngine;
    abortSignal?: AbortSignal;
    maxOutput?: number;
    checker?: PermissionChecker;
    cwd?: string;
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
    checker:
      opts.checker ?? new PermissionChecker(process.cwd(), "bypassPermissions"),
    conversation: conversation,
    cwd: opts.cwd ?? process.cwd(),
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
    const client = new MockClient([
      [{ type: "text_delta", text: "hello" }, end()],
    ]);
    const { events, conversation } = await runAgent(client);

    expect(
      events.some((e) => e.type === "stream_text" && e.text === "hello"),
    ).toBe(true);
    const lc = events.find((e) => e.type === "loop_complete");
    expect(lc?.type === "loop_complete" && lc.stopReason).toBe("end_turn");

    const last = conversation.getMessages().at(-1);
    expect(last?.role).toBe("assistant");
    expect(last?.content).toBe("hello");
  });

  it("does not add an empty assistant message for an empty end turn", async () => {
    const { conversation } = await runAgent(new MockClient([[end()]]));

    expect(conversation.getMessages()).toHaveLength(1);
    expect(conversation.getMessages()[0]?.role).toBe("user");
  });

  it("keeps the client default when no output ceiling is supplied by the host", async () => {
    const client = new MockClient([[end()]]);
    await runAgent(client);
    expect(client.outputLimits).toEqual([8192]);
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

    expect(
      events.some((e) => e.type === "tool_use" && e.toolName === "Echo"),
    ).toBe(true);
    const tr = events.find((e) => e.type === "tool_result");
    expect(tr?.type === "tool_result" && tr.output).toBe("echoed");
    expect(tr?.type === "tool_result" && tr.isError).toBe(false);
    expect(events.some((e) => e.type === "turn_complete")).toBe(true);
    expect(events.some((e) => e.type === "loop_complete")).toBe(true);
  });

  it("pairs malformed no-arg tool calls with an error without invoking them", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({ output: "should not run", isError: false }),
    );
    const noArgTool: Tool = {
      ...echoTool,
      name: "NoArgs",
      execute,
    };
    const client = new MockClient([
      [
        {
          type: "tool_call_complete",
          toolId: "bad-json",
          toolName: "NoArgs",
          arguments: {},
          parseError: "Invalid tool arguments JSON: unexpected end of input",
        },
        end("tool_use"),
      ],
      [{ type: "text_delta", text: "recovered" }, end()],
    ]);

    const { events } = await runAgent(client, { tool: noArgTool });
    const result = events.find(
      (event) => event.type === "tool_result" && event.toolId === "bad-json",
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      type: "tool_result",
      toolId: "bad-json",
      isError: true,
    });
    expect(result?.type === "tool_result" ? result.output : "").toContain(
      "tool was not executed",
    );
  });

  it("escalates output ceiling and retries on max_tokens", async () => {
    const client = new MockClient([
      [{ type: "text_delta", text: "partial" }, end("max_tokens")],
      [{ type: "text_delta", text: " done" }, end()],
    ]);
    const { events } = await runAgent(client, { maxOutput: 8192 });

    expect(
      events.some((e) => e.type === "retry" && e.reason.includes("max_tokens")),
    ).toBe(true);
    expect(client.outputLimits).toEqual([8192, 64000]);
    expect(events.some((e) => e.type === "loop_complete")).toBe(true);
  });

  it("isolates output-limit recovery between concurrent agents sharing a client", async () => {
    let defaultLimit = 8192;
    const limits = new Map<ConversationManager, number[]>();
    const client: LLMClient = {
      setSystemPrompt: () => undefined,
      setMaxOutputTokens: vi.fn((limit: number) => {
        defaultLimit = limit;
      }),
      async *stream(
        conversation,
        _tools,
        _signal,
        options?: { maxOutputTokens?: number },
      ) {
        await Promise.resolve();
        const requests = limits.get(conversation) ?? [];
        requests.push(options?.maxOutputTokens ?? defaultLimit);
        limits.set(conversation, requests);
        yield end(requests.length === 1 ? "max_tokens" : "end_turn");
      },
    };
    const makeAgent = () => {
      const conversation = new ConversationManager();
      conversation.addUserMessage("hi");
      const iterator = new Agent({
        client,
        conversation,
        cwd: process.cwd(),
        registry: new ToolRegistry(),
        checker: new PermissionChecker(process.cwd(), "bypassPermissions"),
        maxOutput: 8192,
      }).run();
      return { conversation, iterator };
    };
    const pauseAtRetry = async (iterator: AsyncGenerator<AgentEvent>) => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          throw new Error("Expected output-limit recovery");
        }
        if (next.value.type === "retry") {
          return;
        }
      }
    };
    const first = makeAgent();
    const second = makeAgent();
    try {
      await pauseAtRetry(first.iterator);
      await pauseAtRetry(second.iterator);
      const firstEvents = [];
      for await (const event of first.iterator) {
        firstEvents.push(event);
      }
      const secondEvents = [];
      for await (const event of second.iterator) {
        secondEvents.push(event);
      }
      expect(firstEvents.at(-1)).toMatchObject({
        type: "loop_complete",
        stopReason: "end_turn",
      });
      expect(secondEvents.at(-1)).toMatchObject({
        type: "loop_complete",
        stopReason: "end_turn",
      });
      expect(limits.get(second.conversation)?.at(-1)).toBe(64000);
      expect(limits.get(first.conversation)).toEqual([8192, 64000]);
      expect(limits.get(second.conversation)).toEqual([8192, 64000]);
      expect(client.setMaxOutputTokens).not.toHaveBeenCalled();
      expect(defaultLimit).toBe(8192);
    } finally {
      await first.iterator.return(undefined);
      await second.iterator.return(undefined);
    }
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
    expect(results.every((e) => e.type === "tool_result" && e.isError)).toBe(
      true,
    );
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
    expect(usage?.type === "usage" && usage.usage.cacheReadInputTokens).toBe(
      1000,
    );
    expect(
      usage?.type === "usage" && usage.usage.cacheCreationInputTokens,
    ).toBe(200);
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
          controller.abort();
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
    expect(tr?.type === "tool_result" && tr.output).toContain(
      "not in plan mode",
    );
    // The errored call must not end the loop: the model gets a second turn to self-correct.
    expect(client.calls).toBe(2);
    expect(
      conversation
        .getMessages()
        .some((m) => contentToText(m.content).includes("recovered")),
    ).toBe(true);
  });

  it("ends the loop when ExitPlanMode succeeds", async () => {
    const exitPlan = new ExitPlanModeTool();
    const cwd = mkdtempSync(join(tmpdir(), "yukino-exit-plan-"));
    const checker = new PermissionChecker(cwd, "plan");
    writeFileSync(
      getOrCreatePlanPath(checker),
      "# Ready plan\nImplement and verify.",
    );
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
    const { events, conversation } = await runAgent(client, {
      tool: exitPlan,
      checker,
      cwd,
    });

    rmSync(cwd, { recursive: true, force: true });
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
      conversation
        .getMessages()
        .some((m) => contentToText(m.content).includes("REMINDER_NOTE")),
    ).toBe(true);
  });
});
