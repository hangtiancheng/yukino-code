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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  MIN_THINKING_ANSWER_TOKENS,
  THINKING_LEVELS,
  thinkingBudgetForLevel,
  type ProviderConfig,
} from "@/config/index.js";
import { ConversationManager } from "@/conversation/index.js";
import { AnthropicClient } from "@/llm/anthropic.js";
import type { LLMClient } from "@/llm/client.js";
import { OpenAIClient, OpenAICompatClient } from "@/llm/openai.js";
import type { ToolSchema } from "@/tools/types.js";

const protocols: ProviderConfig["protocol"][] = ["anthropic", "openai", "openai-compat"];
const openAIProtocols: ProviderConfig["protocol"][] = ["openai", "openai-compat"];
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

function provider(
  protocol: ProviderConfig["protocol"],
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    name: "test",
    protocol,
    base_url: "https://example.invalid",
    api_key: "test",
    model: "arbitrary-model-name",
    ...overrides,
  };
}

function createClient(config: ProviderConfig) {
  switch (config.protocol) {
    case "anthropic":
      return new AnthropicClient(config, "system");
    case "openai":
      return new OpenAIClient(config, "system");
    case "openai-compat":
      return new OpenAICompatClient(config, "system");
  }
}

function terminalEvents(protocol: ProviderConfig["protocol"]): Record<string, unknown>[] {
  if (protocol === "anthropic") {
    return [
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
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ];
  }
  if (protocol === "openai") {
    return [
      {
        type: "response.completed",
        sequence_number: 0,
        response: { id: "resp_test", status: "completed" },
      },
    ];
  }
  return [
    {
      type: "chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
}

// Exercise real SDK serialization at the HTTP boundary, without calling a provider.
async function request(
  client: LLMClient,
  protocol: ProviderConfig["protocol"],
  tools: ToolSchema[] = [],
): Promise<Record<string, unknown>> {
  const payloads: Record<string, unknown>[] = [];
  fetchMock.mockImplementation((_input, init) => {
    const raw: unknown = JSON.parse(z.string().parse(init?.body));
    payloads.push(z.record(z.string(), z.unknown()).parse(raw));
    const events = terminalEvents(protocol);
    return Promise.resolve(
      new Response(
        events
          .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
  });
  const conversation = new ConversationManager();
  conversation.addUserMessage("hello");
  const events = [];
  for await (const event of client.stream(conversation, tools)) {
    events.push(event);
  }
  expect(events.some((event) => event.type === "stream_end")).toBe(true);
  expect(payloads).toHaveLength(1);
  return payloads[0];
}

afterEach(() => vi.unstubAllGlobals());

describe.each(openAIProtocols)("%s thinking payloads", (protocol) => {
  it.each(THINKING_LEVELS)(
    "sends the native effort for %s, including explicit none for off",
    async (level) => {
      const client = createClient(provider(protocol));
      expect(client.getThinkingLevel()).toBe("high");
      expect(client.setThinkingLevel(level)).toBe(level);
      expect(client.getThinkingLevel()).toBe(level);
      const payload = await request(client, protocol);
      const effort = level === "off" ? "none" : level;
      if (protocol === "openai") {
        expect(payload.reasoning).toEqual(
          level === "off" ? { effort } : { effort, summary: "auto" },
        );
      } else {
        expect(payload.reasoning_effort).toBe(effort);
      }
    },
  );

  it("ignores Anthropic adaptive mode for native OpenAI efforts", async () => {
    const client = createClient(
      provider(protocol, { thinking_mode: "adaptive", thinking: "minimal" }),
    );
    const payload = await request(client, protocol);
    expect(protocol === "openai" ? payload.reasoning : payload.reasoning_effort).toEqual(
      protocol === "openai" ? { effort: "minimal", summary: "auto" } : "minimal",
    );
    expect(payload).not.toHaveProperty("output_config");
  });
});

describe.each(protocols)("%s explicit capabilities", (protocol) => {
  it.each(THINKING_LEVELS)(
    "omits reasoning fields for configured reasoning:false at %s",
    async (level) => {
      // This is configured capability, not inference from a familiar model name.
      const client = createClient(
        provider(protocol, {
          model: "reasoning-max-model",
          reasoning: false,
          thinking: level,
        }),
      );
      expect(client.getSupportedThinkingLevels()).toEqual(["off"]);
      expect(client.getThinkingLevel()).toBe("off");
      expect(client.setThinkingLevel(level)).toBe("off");
      const payload = await request(client, protocol);
      for (const field of ["reasoning", "reasoning_effort", "thinking", "output_config"]) {
        expect(payload).not.toHaveProperty(field);
      }
    },
  );

  it("maps native effort without relabeling the effective logical level", async () => {
    const client = createClient(provider(protocol, { thinking_level_map: { low: "medium" } }));
    expect(client.setThinkingLevel("low")).toBe("low");
    expect(client.getThinkingLevel()).toBe("low");
    const payload = await request(client, protocol);
    if (protocol === "anthropic") {
      expect(payload.thinking).toEqual({
        type: "enabled",
        budget_tokens: 8192,
      });
    } else if (protocol === "openai") {
      expect(payload.reasoning).toEqual({ effort: "medium", summary: "auto" });
    } else {
      expect(payload.reasoning_effort).toBe("medium");
    }
  });

  it("clamps null/none mappings down and reports the same level it sends", async () => {
    const client = createClient(
      provider(protocol, {
        thinking: "max",
        thinking_level_map: { max: null, xhigh: null, high: "none" },
      }),
    );
    expect(client.getSupportedThinkingLevels()).toEqual(["off", "minimal", "low", "medium"]);
    expect(client.getThinkingLevel()).toBe("medium");
    expect(client.setThinkingLevel("high")).toBe("medium");
    const payload = await request(client, protocol);
    if (protocol === "anthropic") {
      expect(payload.thinking).toEqual({
        type: "enabled",
        budget_tokens: 8192,
      });
    } else if (protocol === "openai") {
      expect(payload.reasoning).toEqual({ effort: "medium", summary: "auto" });
    } else {
      expect(payload.reasoning_effort).toBe("medium");
    }
  });

  it("clamps to off when every enabled mapping is disabled", async () => {
    const client = createClient(
      provider(protocol, {
        thinking_level_map: {
          off: null,
          minimal: null,
          low: null,
          medium: null,
          high: null,
          xhigh: null,
          max: null,
        },
      }),
    );
    expect(client.getSupportedThinkingLevels()).toEqual(["off"]);
    expect(client.setThinkingLevel("max")).toBe("off");
    const payload = await request(client, protocol);
    if (protocol === "anthropic") {
      expect(payload.thinking).toEqual({ type: "disabled" });
    } else if (protocol === "openai") {
      expect(payload.reasoning).toEqual({ effort: "none" });
    } else {
      expect(payload.reasoning_effort).toBe("none");
    }
  });
});

describe("Anthropic thinking modes", () => {
  it.each(THINKING_LEVELS)("uses budget mode by default for %s", async (level) => {
    const client = new AnthropicClient(provider("anthropic", { thinking: level }), "system");
    const payload = await request(client, "anthropic");
    expect(client.getThinkingLevel()).toBe(level);
    expect(payload.thinking).toEqual(
      level === "off"
        ? { type: "disabled" }
        : { type: "enabled", budget_tokens: thinkingBudgetForLevel(level) },
    );
    expect(payload.max_tokens).toBe(128000);
    expect(payload).not.toHaveProperty("output_config");
  });

  it.each([
    { level: "off", effort: null },
    { level: "minimal", effort: "low" },
    { level: "low", effort: "low" },
    { level: "medium", effort: "medium" },
    { level: "high", effort: "high" },
    { level: "xhigh", effort: "high" },
    { level: "max", effort: "max" },
  ])("uses adaptive thinking and mapped effort for $level", async ({ level, effort }) => {
    const thinking = z.enum(THINKING_LEVELS).parse(level);
    const client = new AnthropicClient(
      provider("anthropic", { thinking_mode: "adaptive", thinking }),
      "system",
    );
    const payload = await request(client, "anthropic");
    expect(client.getThinkingLevel()).toBe(thinking);
    expect(payload.thinking).toEqual({
      type: thinking === "off" ? "disabled" : "adaptive",
    });
    if (effort === null) {
      expect(payload).not.toHaveProperty("output_config");
    } else {
      expect(payload.output_config).toEqual({ effort });
    }
  });

  it("supports explicit adaptive overrides but never sends an illegal native effort", async () => {
    const client = new AnthropicClient(
      provider("anthropic", {
        thinking_mode: "adaptive",
        thinking_level_map: { high: "minimal", xhigh: "xhigh", max: "low" },
      }),
      "system",
    );
    expect(client.getSupportedThinkingLevels()).not.toContain("high");
    expect(client.getThinkingLevel()).toBe("medium");
    expect((await request(client, "anthropic")).output_config).toEqual({
      effort: "medium",
    });
    expect(client.setThinkingLevel("xhigh")).toBe("xhigh");
    expect((await request(client, "anthropic")).output_config).toEqual({
      effort: "xhigh",
    });
    expect(client.setThinkingLevel("max")).toBe("max");
    expect((await request(client, "anthropic")).output_config).toEqual({
      effort: "low",
    });
  });

  it.each([1, 1024, 1151, 1152, 2048, 4096])(
    "keeps budget thinking inside a %i-token output ceiling",
    async (cap) => {
      const client = new AnthropicClient(
        provider("anthropic", {
          thinking_mode: "budget",
          thinking: "max",
          max_output_tokens: cap,
        }),
        "system",
      );
      const payload = await request(client, "anthropic");
      expect(payload.max_tokens).toBe(cap);
      if (cap < 1024 + MIN_THINKING_ANSWER_TOKENS) {
        expect(client.getSupportedThinkingLevels()).toEqual(["off"]);
        expect(client.getThinkingLevel()).toBe("off");
        expect(client.setThinkingLevel("high")).toBe("off");
        expect(payload.thinking).toEqual({ type: "disabled" });
      } else {
        expect(client.getThinkingLevel()).toBe("max");
        expect(payload.thinking).toEqual({
          type: "enabled",
          budget_tokens: cap - MIN_THINKING_ANSWER_TOKENS,
        });
      }
    },
  );

  it("recalculates availability and effective level when runtime output limits change", async () => {
    const client = new AnthropicClient(provider("anthropic", { context_window: 4096 }), "system");
    client.setMaxOutputTokens(1151);
    expect(client.getSupportedThinkingLevels()).toEqual(["off"]);
    expect(client.getThinkingLevel()).toBe("off");
    expect((await request(client, "anthropic")).thinking).toEqual({
      type: "disabled",
    });
    client.setMaxOutputTokens(8192);
    expect(client.getSupportedThinkingLevels()).toEqual(THINKING_LEVELS);
    expect(client.setThinkingLevel("high")).toBe("high");
    const payload = await request(client, "anthropic");
    expect(payload.max_tokens).toBe(4096);
    expect(payload.thinking).toEqual({
      type: "enabled",
      budget_tokens: 4096 - MIN_THINKING_ANSWER_TOKENS,
    });
  });

  it("does not apply the budget minimum to adaptive thinking", async () => {
    const client = new AnthropicClient(
      provider("anthropic", {
        thinking_mode: "adaptive",
        max_output_tokens: 1024,
      }),
      "system",
    );
    expect(client.getThinkingLevel()).toBe("high");
    expect((await request(client, "anthropic")).thinking).toEqual({
      type: "adaptive",
    });
  });
});

describe.each(protocols)("%s tool schema fidelity", (protocol) => {
  it("preserves complete schemas and only uses the protocol's required function wrapper", async () => {
    const inputSchema: ToolSchema["input_schema"] & Record<string, unknown> = {
      type: "object",
      properties: { value: { $ref: "#/$defs/value" } },
      required: ["value"],
      additionalProperties: false,
      oneOf: [{ required: ["value"] }],
      $defs: { value: { type: "string", minLength: 2 } },
    };
    const tools: ToolSchema[] = [
      {
        name: "first",
        description: "first tool",
        input_schema: inputSchema,
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
      { name: "second", description: "second tool", input_schema: inputSchema },
      {
        name: "deferred",
        description: "deferred tool",
        input_schema: inputSchema,
        defer_loading: true,
        cache_control: { type: "ephemeral" },
      },
    ];
    const original = structuredClone(tools);
    const payload = await request(createClient(provider(protocol)), protocol, tools);
    const sent = z.array(z.record(z.string(), z.unknown())).parse(payload.tools);
    expect(sent).toHaveLength(3);
    for (const tool of sent) {
      if (protocol === "anthropic") {
        expect(tool.input_schema).toEqual(inputSchema);
        expect(tool).not.toHaveProperty("function");
      } else if (protocol === "openai") {
        expect(tool.parameters).toEqual(inputSchema);
        expect(tool.type).toBe("function");
        expect(tool).not.toHaveProperty("function");
      } else {
        const fn = z.record(z.string(), z.unknown()).parse(tool.function);
        expect(tool.type).toBe("function");
        expect(fn.parameters).toEqual(inputSchema);
        expect(fn).not.toHaveProperty("function");
      }
    }
    if (protocol === "anthropic") {
      expect(sent[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
      expect(sent[1].cache_control).toEqual({ type: "ephemeral" });
      expect(sent[2].defer_loading).toBe(true);
      expect(sent[2]).not.toHaveProperty("cache_control");
    }
    expect(tools).toEqual(original);
  });
});
