import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ProviderConfig } from "@/config/provider-config.js";
import type { Message } from "@/conversation/index.js";
import {
  analyzeHarnessAnomalies,
  buildAnalysisPrompt,
} from "@/feedback/analyze.js";
import type { AnalyzeInput } from "@/feedback/analyze.js";
import { AnthropicClient } from "@/llm/anthropic.js";
import type { LLMClient } from "@/llm/client.js";
import type { StreamEvent } from "@/llm/events.js";

afterEach(() => vi.unstubAllGlobals());

function stubClient(): LLMClient {
  return {
    stream: async function* (): AsyncGenerator<StreamEvent> {
      await Promise.resolve();
      yield* [];
    },
    setSystemPrompt: vi.fn(),
  };
}

function endEvent(stopReason: string): StreamEvent {
  return {
    type: "stream_end",
    stopReason,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  };
}

function makeMessages(count: number, chars = 490): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg-${String(i)} ${"x".repeat(chars)}`,
    });
  }
  return messages;
}

function makeLog(lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    out.push(JSON.stringify({ level: 50, line: i, pad: "y".repeat(60) }));
  }
  return out.join("\n");
}

function promptInput(overrides: Partial<AnalyzeInput>): AnalyzeInput {
  return {
    client: stubClient(),
    messages: [],
    logContent: null,
    description: "",
    filedIssues: [],
    contextWindow: 200_000,
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

describe("buildAnalysisPrompt budget", () => {
  it("keeps the whole prompt inside a tiny real context window", () => {
    // 8k provider: without shared budgeting the old floor (32k) plus the
    // 200k-char log section would overflow the real window many times over.
    const prompt = buildAnalysisPrompt(
      promptInput({
        contextWindow: 8_000,
        messages: makeMessages(200),
        logContent: makeLog(4_000),
      }),
    );

    // Bounded: instructions (~2k chars) + log quarter + conversation rest.
    expect(prompt.length).toBeLessThan(20_000);
    // Conversation truncated to the recent tail.
    expect(prompt).toContain("msg-199");
    expect(prompt).not.toContain("msg-0 ");
    expect(prompt).toContain("messages of the session were omitted");
    // Log scaled down and tail-kept.
    expect(prompt).toContain('"line":3999');
    expect(prompt).not.toContain('"line":0,');
    const logMatch = /<yukino-log>\n([\s\S]*?)\n<\/yukino-log>/.exec(prompt);
    expect(logMatch).toBeTruthy();
    expect(logMatch?.[1].length).toBeLessThanOrEqual(2_000);
  });

  it("caps the log at MAX_LOG_CHARS for very large windows", () => {
    const bigLog = `${"z".repeat(100_000)}\n${makeLog(50)}`;
    const prompt = buildAnalysisPrompt(
      promptInput({
        contextWindow: 1_000_000,
        messages: makeMessages(3),
        logContent: bigLog,
      }),
    );
    const logMatch = /<yukino-log>\n([\s\S]*?)\n<\/yukino-log>/.exec(prompt);
    expect(logMatch).toBeTruthy();
    // 100k filler + ~4k log; the cap (200k) trims the filler, keeps the tail.
    expect(logMatch?.[1].length).toBeLessThanOrEqual(200_000);
    expect(logMatch?.[1]).toContain('"line":49');
  });

  it("still produces a well-formed prompt for a minimal window", () => {
    const prompt = buildAnalysisPrompt(
      promptInput({
        contextWindow: 1_000,
        messages: makeMessages(50),
        logContent: makeLog(500),
        description: "权限弹窗卡死",
      }),
    );
    expect(prompt).toContain("ONLY a JSON object");
    expect(prompt).toContain("权限弹窗卡死");
    expect(prompt.length).toBeLessThan(20_000);
  });

  it("splits multiple defects and lists already-filed issues", () => {
    const prompt = buildAnalysisPrompt(
      promptInput({
        filedIssues: [
          {
            fingerprint: "fp",
            title: "[tool] Bash retry storm",
            url: "https://example.com/issues/1",
            channel: "gh",
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    expect(prompt).toContain("[tool] Bash retry storm");
    expect(prompt).toContain("One issue per distinct defect");
  });

  it("bounds a single oversized tool result and user report", () => {
    const prompt = buildAnalysisPrompt(
      promptInput({
        contextWindow: 32_000,
        description: "report ".repeat(100_000),
        messages: [
          {
            role: "user",
            content: "",
            toolResults: [
              {
                toolUseId: "t1",
                content: "x".repeat(1_000_000) + "FAILURE_TAIL",
                isError: true,
              },
            ],
          },
        ],
      }),
    );
    expect(prompt.length).toBeLessThan(60_000);
    expect(prompt).toContain("FAILURE_TAIL");
    expect(prompt).toContain("truncated");
  });
});

describe("analyzeHarnessAnomalies", () => {
  it("does not treat a disconnected stream as a completed analysis", async () => {
    const client = stubClient();
    client.stream = async function* () {
      await Promise.resolve();
      yield { type: "text_delta", text: '{"issues":[]}' };
    };
    await expect(
      analyzeHarnessAnomalies(promptInput({ client })),
    ).rejects.toThrow("before completion");
  });

  it("bounds the analysis output by the configured provider ceiling", async () => {
    const client = stubClient();
    const stream = vi
      .spyOn(client, "stream")
      .mockImplementation(async function* () {
        await Promise.resolve();
        yield { type: "text_delta", text: '{"issues":[]}' };
        yield endEvent("end_turn");
      });
    await analyzeHarnessAnomalies(
      promptInput({ client, maxOutputTokens: 1024 }),
    );
    expect(stream.mock.calls[0][3]?.maxOutputTokens).toBe(1024);
  });

  it("reserves the thinking budget on top of the answer room", async () => {
    // thinking:max used to squeeze the answer into max_tokens - budget_tokens
    // (1024 tokens), so the JSON reply was cut off with stop_reason max_tokens.
    const client = stubClient();
    client.getOutputBudget = () => ({
      maxOutputTokens: 128_000,
      thinkingTokens: 65_536,
    });
    const stream = vi
      .spyOn(client, "stream")
      .mockImplementation(async function* () {
        await Promise.resolve();
        yield { type: "text_delta", text: '{"issues":[]}' };
        yield endEvent("end_turn");
      });
    await analyzeHarnessAnomalies(
      promptInput({
        client,
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
      }),
    );
    // THINKING_BUDGETS.max (65536) + answer reserve (8000).
    expect(stream.mock.calls[0][3]?.maxOutputTokens).toBe(73_536);
  });

  it("salvages a truncated analysis via a concise retry", async () => {
    const client = stubClient();
    let call = 0;
    const stream = vi
      .spyOn(client, "stream")
      .mockImplementation(async function* (conv) {
        await Promise.resolve();
        call++;
        if (call === 1) {
          yield { type: "text_delta", text: '{"issues":[{"title":"[tool] x"' };
          yield endEvent("max_tokens");
          return;
        }
        const last = conv.getMessages().at(-1);
        expect(JSON.stringify(last?.content)).toContain("output token limit");
        yield {
          type: "text_delta",
          text: '{"issues":[{"title":"[tool] retry","body":"b"}]}',
        };
        yield endEvent("end_turn");
      });
    const issues = await analyzeHarnessAnomalies(promptInput({ client }));
    expect(issues).toEqual([{ title: "[tool] retry", body: "b" }]);
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it("accepts a parseable reply even when it ended at max_tokens", async () => {
    const client = stubClient();
    const stream = vi
      .spyOn(client, "stream")
      .mockImplementation(async function* () {
        await Promise.resolve();
        yield {
          type: "text_delta",
          text: '{"issues":[{"title":"[ui] ok","body":"b"}]}',
        };
        yield endEvent("max_tokens");
      });
    const issues = await analyzeHarnessAnomalies(promptInput({ client }));
    expect(issues).toEqual([{ title: "[ui] ok", body: "b" }]);
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it("falls back to the description when both attempts are truncated", async () => {
    const client = stubClient();
    vi.spyOn(client, "stream").mockImplementation(async function* () {
      await Promise.resolve();
      yield { type: "text_delta", text: '{"issues":[{"title":"' };
      yield endEvent("max_tokens");
    });
    const issues = await analyzeHarnessAnomalies(
      promptInput({ client, description: "权限弹窗卡死" }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.title).toContain("权限弹窗卡死");
  });

  it.each(["max_tokens", "end_turn"])(
    "rejects unusable %s replies after retry when there is no description",
    async (stopReason) => {
      const client = stubClient();
      const stream = vi
        .spyOn(client, "stream")
        .mockImplementation(async function* () {
          await Promise.resolve();
          yield { type: "text_delta", text: '{"issues":[{"title":"' };
          yield endEvent(stopReason);
        });
      await expect(
        analyzeHarnessAnomalies(promptInput({ client })),
      ).rejects.toThrow(
        stopReason === "max_tokens"
          ? "max_tokens after retry"
          : "valid issue JSON after retry",
      );
      expect(stream).toHaveBeenCalledTimes(2);
    },
  );
});

function analysisResponse(): Response {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_analysis",
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
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: '{"issues":[]}' },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const budgetCases: {
  name: string;
  provider: Partial<ProviderConfig>;
  output: number;
  thinking: number;
}[] = [
  {
    name: "uncapped max thinking",
    provider: {},
    output: 73_536,
    thinking: 65_536,
  },
  {
    name: "200k context",
    provider: { context_window: 200_000 },
    output: 50_000,
    thinking: 42_000,
  },
  {
    name: "64k provider ceiling without runtime metadata",
    provider: { max_output_tokens: 64_000 },
    output: 64_000,
    thinking: 56_000,
  },
  {
    name: "high mapped to max",
    provider: { thinking: "high", thinking_level_map: { high: "max" } },
    output: 73_536,
    thinking: 65_536,
  },
  {
    name: "max mapped to low",
    provider: { thinking_level_map: { max: "low" } },
    output: 10_048,
    thinking: 2_048,
  },
  {
    name: "no room for thinking",
    provider: { max_output_tokens: 8_000 },
    output: 8_000,
    thinking: 0,
  },
  {
    name: "less than the minimum thinking budget",
    provider: { max_output_tokens: 9_000 },
    output: 9_000,
    thinking: 0,
  },
  {
    name: "exactly the minimum thinking budget",
    provider: { max_output_tokens: 9_024 },
    output: 9_024,
    thinking: 1_024,
  },
  {
    name: "tiny provider ceiling",
    provider: { max_output_tokens: 1_024 },
    output: 1_024,
    thinking: 0,
  },
  {
    name: "tiny context",
    provider: { context_window: 8_000 },
    output: 2_000,
    thinking: 0,
  },
];

describe("analysis SDK request budgets", () => {
  it.each(budgetCases)(
    "preserves answer space with $name",
    async ({ provider, output, thinking }) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(() => Promise.resolve(analysisResponse()));
      vi.stubGlobal("fetch", fetchMock);
      const config: ProviderConfig = {
        name: "test",
        protocol: "anthropic",
        base_url: "https://example.invalid",
        api_key: "test",
        model: "test",
        thinking_mode: "budget",
        thinking: "max",
        context_window: 1_000_000,
        max_output_tokens: 128_000,
        ...provider,
      };
      const client = new AnthropicClient(config, "system");
      const sessionBudget = client.getOutputBudget();
      const sessionLevel = client.getThinkingLevel();
      await expect(
        analyzeHarnessAnomalies(
          promptInput({
            client,
            contextWindow: config.context_window ?? 1_000_000,
          }),
        ),
      ).resolves.toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const raw: unknown = JSON.parse(
        z.string().parse(fetchMock.mock.calls[0][1]?.body),
      );
      const payload = z
        .object({
          max_tokens: z.number(),
          thinking: z.object({
            type: z.string(),
            budget_tokens: z.number().optional(),
          }),
        })
        .parse(raw);
      expect(payload.max_tokens).toBe(output);
      expect(payload.thinking).toEqual(
        thinking > 0
          ? { type: "enabled", budget_tokens: thinking }
          : { type: "disabled" },
      );
      expect(payload.max_tokens - thinking).toBeGreaterThanOrEqual(
        Math.min(output, 8_000),
      );
      expect(client.getOutputBudget()).toEqual(sessionBudget);
      expect(client.getThinkingLevel()).toBe(sessionLevel);
    },
  );
});
