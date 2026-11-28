import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ProviderConfigSchema,
  type ProviderConfig,
} from "@/config/provider-config.js";
import { ConversationManager } from "@/conversation/index.js";
import { withExecutionContext } from "@/cost/context.js";
import { createCostLedger } from "@/cost/ledger.js";
import { AnthropicClient } from "@/llm/anthropic.js";
import { createClient, measureClient, type LLMClient } from "@/llm/client.js";
import { NetworkError, ServerError } from "@/llm/errors.js";
import type { StreamEvent } from "@/llm/events.js";
import { OpenAIClient, OpenAICompatClient } from "@/llm/openai.js";

vi.mock("@/config/index.js", () => ({
  resolveAPIKey: (provider: ProviderConfig) => provider.api_key,
}));

const now = Date.parse("2026-01-01T00:00:00Z");
const normalized = {
  inputTokens: 15,
  outputTokens: 7,
  cacheReadInputTokens: 5,
  cacheCreationInputTokens: 0,
};
const rawUsage = {
  input_tokens: 20,
  output_tokens: 7,
  input_tokens_details: { cached_tokens: 5 },
  output_tokens_details: { reasoning_tokens: 3 },
};
afterEach(() => {
  vi.unstubAllGlobals();
});
function config(
  protocol: ProviderConfig["protocol"] = "openai",
): ProviderConfig {
  return ProviderConfigSchema.parse({
    name: "opaque",
    model: "opaque",
    protocol,
    base_url: "https://example.invalid",
    api_key: "mock",
    price: {
      currency: "USD",
      input: 1,
      output: 2,
      cache_read: 0.1,
      cache_write: 1.2,
      source: "explicit fixture",
      effective_at: "2025-01-01T00:00:00Z",
    },
  });
}
function sse(events: Record<string, unknown>[]): Response {
  return new Response(
    events
      .map(
        (event) =>
          `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
function completed(usage: unknown = rawUsage): Record<string, unknown> {
  return {
    type: "response.completed",
    sequence_number: 1,
    response: { id: "resp", status: "completed", usage },
  };
}
function conversation(): ConversationManager {
  const conv = new ConversationManager();
  conv.addUserMessage("test");
  return conv;
}
async function collect(
  stream: AsyncGenerator<StreamEvent>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}
function setup() {
  const ledger = createCostLedger({ sessionId: "session", clock: () => now });
  return {
    ledger,
    context: {
      sessionId: "session",
      runId: "main",
      agentId: "agent",
      purpose: "main" as const,
      ledger,
    },
  };
}

describe("real SDK attempt boundary", () => {
  it.each(["anthropic", "openai", "openai-compat"] as const)(
    "records a %s normalized request",
    async (protocol) => {
      const events =
        protocol === "anthropic"
          ? [
              {
                type: "message_start",
                message: {
                  id: "msg",
                  type: "message",
                  role: "assistant",
                  model: "opaque",
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: {
                    input_tokens: 15,
                    output_tokens: 0,
                    cache_read_input_tokens: 5,
                    cache_creation_input_tokens: 0,
                  },
                },
              },
              {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 7 },
              },
              { type: "message_stop" },
            ]
          : protocol === "openai"
            ? [completed()]
            : [
                {
                  type: "chunk",
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                },
                {
                  type: "chunk",
                  choices: [],
                  usage: {
                    prompt_tokens: 20,
                    completion_tokens: 7,
                    prompt_tokens_details: { cached_tokens: 5 },
                    completion_tokens_details: { reasoning_tokens: 3 },
                  },
                },
              ];
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(sse(events))),
      );
      const { ledger, context } = setup();
      const client = await createClient(config(protocol), "system");
      await withExecutionContext(context, () =>
        collect(client.stream(conversation(), [])),
      );
      expect(ledger.getEntries()).toHaveLength(1);
      expect(ledger.getEntries()[0]).toMatchObject({
        usage: normalized,
        usageComplete: true,
        outcome: "completed",
      });
      expect(ledger.summary().estimated.USD.amount).toBeCloseTo(
        (15 + 14 + 0.5) / 1_000_000,
      );
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["anthropic", "openai", "openai-compat"] as const)(
    "disables hidden SDK retries and records %s attempts independently",
    async (protocol) => {
      const fetchMock = vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: "retry" } }), {
            status: 503,
            headers: { "content-type": "application/json", "retry-after": "0" },
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { ledger, context } = setup();
      const client = await createClient(config(protocol), "system");
      await expect(
        withExecutionContext(context, () =>
          collect(
            client.stream(conversation(), [], undefined, { maxRetries: 1 }),
          ),
        ),
      ).rejects.toBeInstanceOf(ServerError);
      const entries = ledger.getEntries();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(entries).toHaveLength(2);
      expect(new Set(entries.map((entry) => entry.requestId)).size).toBe(1);
      expect(new Set(entries.map((entry) => entry.attemptId)).size).toBe(2);
      expect(entries.map((entry) => entry.attempt)).toEqual([0, 1]);
      expect(
        entries.every(
          (entry) => entry.estimate.amount === null && !entry.usageComplete,
        ),
      ).toBe(true);
    },
  );
  it("retries a pre-output failure and does not double-measure createClient plus wrapper", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "retry" } }), {
          status: 503,
          headers: { "content-type": "application/json", "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce(sse([completed(), completed()]));
    vi.stubGlobal("fetch", fetchMock);
    const { ledger, context } = setup();
    const client = measureClient(
      await createClient(config(), "system"),
      config(),
      ledger,
    );
    await withExecutionContext(context, () =>
      collect(client.stream(conversation(), [], undefined, { maxRetries: 1 })),
    );
    expect(ledger.summary()).toMatchObject({
      requests: 1,
      attempts: 2,
      usage: normalized,
    });
    expect(ledger.getEntries().map((entry) => entry.outcome)).toEqual([
      "error",
      "completed",
    ]);
  });
  it("saves failed response usage and never retries after partial usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          sse([
            {
              type: "response.in_progress",
              sequence_number: 0,
              response: { id: "resp", status: "in_progress", usage: rawUsage },
            },
            {
              type: "response.failed",
              sequence_number: 1,
              response: {
                status: "failed",
                usage: rawUsage,
                error: { code: "server_error", message: "failed" },
              },
            },
          ]),
        ),
      ),
    );
    const { ledger, context } = setup();
    await expect(
      withExecutionContext(context, () =>
        collect(
          new OpenAIClient(config(), "system").stream(
            conversation(),
            [],
            undefined,
            { maxRetries: 3 },
          ),
        ),
      ),
    ).rejects.toThrow("failed");
    expect(ledger.getEntries()[0]).toMatchObject({
      usage: { ...normalized, reasoningTokens: 3 },
      outcome: "error",
      usageComplete: false,
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
  it("does not turn absent terminal usage into a zero-cost estimate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(sse([completed(null)]))),
    );
    const { ledger, context } = setup();
    await withExecutionContext(context, () =>
      collect(new OpenAIClient(config(), "system").stream(conversation(), [])),
    );
    expect(ledger.getEntries()[0]).toMatchObject({
      usage: null,
      usageComplete: false,
      estimate: { amount: null },
    });
  });
  it("retains Anthropic partial usage when the consumer returns", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          sse([
            {
              type: "message_start",
              message: {
                id: "msg",
                type: "message",
                role: "assistant",
                model: "opaque",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                  input_tokens: 15,
                  output_tokens: 0,
                  cache_read_input_tokens: 5,
                  cache_creation_input_tokens: 3,
                  cache_creation: {
                    ephemeral_5m_input_tokens: 1,
                    ephemeral_1h_input_tokens: 2,
                  },
                },
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
              delta: { type: "text_delta", text: "partial" },
            },
          ]),
        ),
      ),
    );
    const { ledger, context } = setup();
    const stream = withExecutionContext(context, () =>
      new AnthropicClient(config("anthropic"), "system").stream(
        conversation(),
        [],
      ),
    );
    expect((await stream.next()).value).toEqual({
      type: "text_delta",
      text: "partial",
    });
    await stream.return(undefined);
    expect(ledger.getEntries()[0]).toMatchObject({
      outcome: "incomplete",
      usageComplete: false,
      usage: { inputTokens: 15, cacheCreationByTTL: { "300": 1, "3600": 2 } },
    });
  });
});

describe("injected clients and ALS attribution", () => {
  it("binds lazy generators to concurrent agents even when consumed outside their context", async () => {
    const { ledger, context } = setup();
    const mock: LLMClient = {
      setSystemPrompt() {},
      async *stream(_conv, _tools, _signal, options) {
        await Promise.resolve();
        options?.attemptObserver?.snapshot({ inputTokens: 15 });
        yield { type: "usage_snapshot", usage: normalized };
        yield { type: "stream_end", stopReason: "end_turn", usage: normalized };
      },
    };
    const client = measureClient(mock, config());
    const streams = ["a", "b"].map((agentId) =>
      withExecutionContext(
        {
          ...context,
          agentId,
          runId: agentId,
          parentRunId: "main",
          purpose: "subagent",
        },
        () => client.stream(conversation(), []),
      ),
    );
    await Promise.all(streams.map(collect));
    expect(
      ledger
        .getEntries()
        .map((entry) => entry.agentId)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(
      ledger.summary({ runId: "main", includeDescendants: true }).usage
        .outputTokens,
    ).toBe(14);
  });
  it("records injected real attempts and idempotent usage events", async () => {
    const { ledger, context } = setup();
    let calls = 0;
    const mock: LLMClient = {
      setSystemPrompt() {},
      async *stream(_conv, _tools, _signal, options) {
        await Promise.resolve();
        expect(options?.maxRetries).toBe(0);
        if (++calls === 1) {
          throw new ServerError("retry", "0");
        }
        options?.attemptObserver?.snapshot(normalized);
        options?.attemptObserver?.snapshot(normalized);
        yield { type: "stream_end", stopReason: "end_turn", usage: normalized };
      },
    };
    const client = measureClient(measureClient(mock, config()), config());
    await withExecutionContext(context, () =>
      collect(client.stream(conversation(), [], undefined, { maxRetries: 1 })),
    );
    expect(ledger.summary()).toMatchObject({
      attempts: 2,
      requests: 1,
      usage: normalized,
    });
  });
  it("preserves last usage on abort without adding invented output", async () => {
    const { ledger, context } = setup();
    const abort = new AbortController();
    const mock: LLMClient = {
      setSystemPrompt() {},
      async *stream(_conv, _tools, _signal, options) {
        await Promise.resolve();
        options?.attemptObserver?.snapshot({ inputTokens: 12 });
        yield { type: "text_delta", text: "partial" };
        abort.abort();
        throw new NetworkError("abort");
      },
    };
    await expect(
      withExecutionContext(context, () =>
        collect(
          measureClient(mock, config()).stream(
            conversation(),
            [],
            abort.signal,
          ),
        ),
      ),
    ).rejects.toThrow("abort");
    expect(ledger.getEntries()[0]).toMatchObject({
      outcome: "aborted",
      usageComplete: false,
      usage: { inputTokens: 12 },
      estimate: { amount: null },
    });
  });
  it("does not start a request for an already aborted signal", async () => {
    const { ledger, context } = setup();
    const abort = new AbortController();
    abort.abort();
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      withExecutionContext(context, () =>
        collect(
          new OpenAICompatClient(config("openai-compat"), "system").stream(
            conversation(),
            [],
            abort.signal,
          ),
        ),
      ),
    ).rejects.toThrow();
    expect(ledger.summary().attempts).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
