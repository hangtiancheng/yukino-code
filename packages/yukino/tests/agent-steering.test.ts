import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, it, expect, vi } from "vitest";

import type { AgentEvent } from "@/agent/events.js";
import { Agent } from "@/agent/index.js";
import * as atExpand from "@/conversation/at-expand.js";
import { ConversationManager } from "@/conversation/index.js";
import type { LLMClient } from "@/llm/client.js";
import type { StreamEvent, UsageInfo } from "@/llm/events.js";
import { PermissionChecker } from "@/permissions/index.js";
import { getYukinoDir } from "@/storage/index.js";
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
  abortSignal?: AbortSignal,
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
    cwd: process.cwd(),
    abortSignal,
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
  it.each(["recall", "abort"])(
    "keeps an image reference queued while expanding so %s can prevent delivery",
    async (action) => {
      let started!: () => void;
      const expanding = new Promise<void>((resolve) => {
        started = resolve;
      });
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const expansion = vi
        .spyOn(atExpand, "expandAtRefsWithImages")
        .mockImplementationOnce(async () => {
          started();
          await waiting;
          return [
            { type: "text", text: "expanded screenshot" },
            {
              type: "image",
              source: { type: "url", url: "https://example.invalid/image.png" },
            },
          ];
        });
      const controller = new AbortController();
      const client = new ScriptedClient([[end()]]);
      const { agent, conversation } = makeAgent(
        client,
        undefined,
        controller.signal,
      );
      const entry = agent.steer("@screenshot.png");
      if (!entry) {
        throw new Error("Missing steering input");
      }
      const running = collect(agent);
      try {
        await expanding;
        if (action === "recall") {
          expect(agent.removeSteering(entry.id)).toBe(true);
        } else {
          controller.abort();
        }
      } finally {
        release();
        expansion.mockRestore();
      }
      const events = await running;
      expect(events.some((event) => event.type === "steering_delivered")).toBe(
        false,
      );
      expect(
        conversation
          .getMessages()
          .some((message) => Array.isArray(message.content)),
      ).toBe(false);
      if (action === "abort") {
        expect(agent.drainSteering()[0]?.text).toBe("@screenshot.png");
      }
    },
  );

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
    expect(events.findIndex((e) => e.type === "turn_complete")).toBeLessThan(
      events.findIndex((e) => e.type === "steering_delivered"),
    );

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

  it("expands a queued TUI image reference after tool results and allows recall before delivery", async () => {
    const cwd = join(dirname(getYukinoDir()), "steering-images");
    mkdirSync(cwd, { recursive: true });
    const imagePath = join(cwd, "screenshot.png");
    writeFileSync(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const tool = echoTool(() => {
      const recalled = agent.steer(`recall @${imagePath}`);
      if (!recalled) {
        throw new Error("Missing steering receipt");
      }
      expect(agent.removeSteering(recalled.id)).toBe(true);
      agent.steer(`correction @${imagePath}`);
    });
    const client = new ScriptedClient([
      [
        {
          type: "tool_call_complete",
          toolId: "image-tool",
          toolName: "Echo",
          arguments: {},
        },
        end("tool_use"),
      ],
      [end()],
    ]);
    const { agent, conversation } = makeAgent(client, tool);
    await collect(agent);
    const messages = conversation.getMessages();
    const index = messages.findIndex((message) =>
      Array.isArray(message.content),
    );
    expect(index).toBeGreaterThan(0);
    expect(messages[index - 1].toolResults?.[0].toolUseId).toBe("image-tool");
    const blocks = messages[index].content;
    if (!Array.isArray(blocks)) {
      throw new Error("Missing image blocks");
    }
    expect(blocks.some((block) => block.type === "image")).toBe(true);
    expect(
      client.transcripts.flat().some((text) => text.startsWith("recall")),
    ).toBe(false);
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
      "user",
      "assistant",
      "user",
      "user",
      "assistant",
    ]);
    expect(contentToText(messages[1]?.content)).toContain(
      "# Active tool guidance",
    );
    expect(messages[3]?.toolResults?.[0]?.content).toBe("echoed");
    expect(contentToText(messages[4]?.content)).toBe("mid-run correction");
    expect(contentToText(messages[5]?.content)).toBe("done");

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
    const input = agent.steer("recalled");
    expect(agent.removeSteering(input?.id ?? "missing")).toBe(true);

    const events = await collect(agent);

    expect(events.some((e) => e.type === "steering_delivered")).toBe(false);
    expect(client.calls).toBe(1);
  });

  it("preserves undelivered steering when interrupted between deliveries", async () => {
    const controller = new AbortController();
    const client = new ScriptedClient([
      [{ type: "text_delta", text: "first" }, end()],
    ]);
    const { agent, conversation } = makeAgent(
      client,
      undefined,
      controller.signal,
    );
    const deliveredInput = agent.steer("delivered note");
    agent.steer("pending note");

    const events: AgentEvent[] = [];
    for await (const event of agent.run()) {
      events.push(event);
      if (event.type === "steering_delivered") {
        controller.abort();
      }
    }

    expect(
      events.filter((event) => event.type === "steering_delivered"),
    ).toEqual([
      {
        type: "steering_delivered",
        text: "delivered note",
        inputId: deliveredInput?.id,
      },
    ]);
    expect(
      conversation
        .getMessages()
        .map((message) => contentToText(message.content)),
    ).toEqual(["hi", "first", "delivered note"]);
    expect(agent.drainSteering().map((message) => message.text)).toEqual([
      "pending note",
    ]);
    expect(events.at(-1)).toEqual({
      type: "loop_complete",
      stopReason: "interrupted",
    });
    expect(client.calls).toBe(1);
  });

  it("preserves all steering when interrupted before delivery at the turn boundary", async () => {
    const controller = new AbortController();
    const client = new ScriptedClient([
      [{ type: "text_delta", text: "first" }, end()],
    ]);
    const { agent, conversation } = makeAgent(
      client,
      undefined,
      controller.signal,
    );
    agent.steer("pending note");

    const events: AgentEvent[] = [];
    for await (const event of agent.run()) {
      events.push(event);
      if (event.type === "turn_complete") {
        controller.abort();
      }
    }

    expect(events.some((event) => event.type === "steering_delivered")).toBe(
      false,
    );
    expect(
      conversation
        .getMessages()
        .map((message) => contentToText(message.content)),
    ).toEqual(["hi", "first"]);
    expect(agent.drainSteering().map((message) => message.text)).toEqual([
      "pending note",
    ]);
    expect(events.at(-1)).toEqual({
      type: "loop_complete",
      stopReason: "interrupted",
    });
    expect(client.calls).toBe(1);
  });
});
