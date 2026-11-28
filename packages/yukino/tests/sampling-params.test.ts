import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ProjectConfigSchema } from "@/config/index.js";
import {
  ProviderConfigSchema,
  resolveSamplingParams,
  type ProviderConfig,
} from "@/config/provider-config.js";
import { ConversationManager } from "@/conversation/index.js";
import { AnthropicClient } from "@/llm/anthropic.js";
import { OpenAIClient, OpenAICompatClient } from "@/llm/openai.js";

const provider: ProviderConfig = {
  name: "sampling",
  protocol: "openai-compat",
  model: "local",
  base_url: "https://example.invalid",
  api_key: "fixture",
  thinking: "high",
  sampling_params: {
    temperature: 0.6,
    top_p: 0.9,
    top_k: 40,
    min_p: 0.05,
    stop: ["END"],
  },
  sampling_params_by_thinking_level: {
    off: { temperature: 0.1 },
    low: { temperature: 0.3 },
    high: { temperature: 0.8, top_k: 60 },
  },
};
afterEach(() => vi.unstubAllGlobals());

describe("sampling parameters", () => {
  it("validates JSON maps and rejects unknown thinking levels", () => {
    expect(ProviderConfigSchema.parse(provider).sampling_params).toEqual(
      provider.sampling_params,
    );
    expect(
      ProjectConfigSchema.parse({
        providers: [
          {
            name: "sampling",
            sampling_params: provider.sampling_params,
            sampling_params_by_thinking_level:
              provider.sampling_params_by_thinking_level,
          },
        ],
      }).providers?.[0].sampling_params,
    ).toEqual(provider.sampling_params);
    for (const override of [
      { sampling_params: [] },
      { sampling_params: { top_p: Number.NaN } },
      { sampling_params: { callback: () => 1 } },
      { sampling_params_by_thinking_level: { invalid: {} } },
      { sampling_params_by_thinking_level: { high: 1 } },
    ]) {
      expect(
        ProviderConfigSchema.safeParse({ ...provider, ...override }).success,
      ).toBe(false);
    }
  });

  it("merges per key without mutating config and clamps before selecting overrides", () => {
    const original = structuredClone(provider);
    const capped = {
      ...provider,
      thinking_level_map: { high: null, medium: null },
    };
    expect(
      resolveSamplingParams(capped, "high", { top_k: 80, stop: null }),
    ).toEqual({
      temperature: 0.3,
      top_p: 0.9,
      top_k: 80,
      min_p: 0.05,
      stop: null,
    });
    expect(
      resolveSamplingParams({ ...provider, reasoning: false }, "high")
        .temperature,
    ).toBe(0.1);
    expect(provider).toEqual(original);
  });

  it.each(["openai", "openai-compat"] as const)(
    "sends merged %s request bodies and respects runtime thinking changes",
    async (protocol) => {
      const bodies: Record<string, unknown>[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((_url, options: RequestInit) => {
          bodies.push(
            z
              .record(z.string(), z.unknown())
              .parse(JSON.parse(z.string().parse(options.body))),
          );
          return Promise.resolve(
            new Response("", {
              headers: { "content-type": "text/event-stream" },
            }),
          );
        }),
      );
      const config = { ...provider, protocol };
      const client =
        protocol === "openai"
          ? new OpenAIClient(config, "system")
          : new OpenAICompatClient(config, "system");
      const conversation = new ConversationManager();
      conversation.addUserMessage("hi");
      for (const level of ["high", "off"] as const) {
        client.setThinkingLevel(level);
        await client
          .stream(conversation, [], undefined, {
            maxRetries: 0,
            samplingParams: { top_k: 80 },
          })
          .next()
          .catch(() => undefined);
      }
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toMatchObject({
        temperature: 0.8,
        top_p: 0.9,
        top_k: 80,
        min_p: 0.05,
        stop: ["END"],
      });
      expect(bodies[1]).toMatchObject({ temperature: 0.1, top_k: 80 });
    },
  );

  it("does not forward OpenAI sampling fields to Anthropic", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, options: RequestInit) => {
        bodies.push(
          z
            .record(z.string(), z.unknown())
            .parse(JSON.parse(z.string().parse(options.body))),
        );
        return Promise.resolve(
          new Response("", {
            headers: { "content-type": "text/event-stream" },
          }),
        );
      }),
    );
    await new AnthropicClient({ ...provider, protocol: "anthropic" }, "system")
      .stream(new ConversationManager(), [], undefined, {
        maxRetries: 0,
        samplingParams: { top_k: 99 },
      })
      .next()
      .catch(() => undefined);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("top_k");
    expect(bodies[0]).not.toHaveProperty("temperature");
  });
});
