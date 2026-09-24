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

import type { LLMClient } from "@/llm/client.js";
import * as telemetry from "@/telemetry/index.js";
import type {
  TelemetryAttributes,
  TelemetryObservation,
  TelemetryObservationKind,
  TelemetryObservationUpdate,
  TelemetryRuntime,
} from "@/telemetry/index.js";
import {
  endAgentTelemetry,
  observeLlmStream,
  observeToolExecution,
  registerLlmClient,
  startAgentTelemetry,
} from "@/telemetry/instrumentation.js";
import { parseExporterTypes } from "@/telemetry/providers.js";

class FakeObservation implements TelemetryObservation {
  readonly children: FakeObservation[] = [];
  readonly updates: TelemetryObservationUpdate[] = [];
  ended = false;
  error: unknown;

  constructor(
    readonly kind: TelemetryObservationKind,
    readonly name: string,
    readonly attributes: TelemetryAttributes,
  ) {}

  end(): void {
    this.ended = true;
  }

  recordException(error: unknown): void {
    this.error = error;
  }

  startChild(
    kind: TelemetryObservationKind,
    name: string,
    attributes: TelemetryAttributes = {},
  ): TelemetryObservation {
    const child = new FakeObservation(kind, name, attributes);
    this.children.push(child);
    return child;
  }

  update(update: TelemetryObservationUpdate): void {
    this.updates.push(update);
  }
}

function createFakeRuntime() {
  const observations: FakeObservation[] = [];
  const recordMetric = vi.fn();
  const runtime = {
    captureError: vi.fn(),
    emitLog: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
    recordMetric,
    setMode: vi.fn(),
    shutdown: vi.fn(() => Promise.resolve()),
    startObservation(
      kind: TelemetryObservationKind,
      name: string,
      attributes: TelemetryAttributes = {},
    ) {
      const observation = new FakeObservation(kind, name, attributes);
      observations.push(observation);
      return observation;
    },
  } satisfies TelemetryRuntime;
  return { observations, recordMetric, runtime };
}

function fakeClient(): LLMClient {
  return {
    protocol: "anthropic",
    setSystemPrompt: vi.fn(),
    stream: async function* () {
      await Promise.resolve();
      yield* [];
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("telemetry instrumentation", () => {
  it("parses standard exporter lists and ignores none", () => {
    expect(parseExporterTypes("otlp, console, none")).toEqual([
      "otlp",
      "console",
    ]);
    expect(parseExporterTypes(undefined)).toEqual([]);
  });

  it("records nested LLM and tool observations without payload content", async () => {
    const { observations, recordMetric, runtime } = createFakeRuntime();
    vi.spyOn(telemetry, "getTelemetryRuntime").mockReturnValue(runtime);

    const client = registerLlmClient(fakeClient(), {
      model: "claude-test",
      protocol: "anthropic",
    });
    const agent = startAgentTelemetry("raw-session-id", client);

    async function* stream() {
      await Promise.resolve();
      yield { type: "text_delta", text: "private model output" } as const;
      yield {
        type: "stream_end",
        stopReason: "end_turn",
        usage: {
          cacheCreationInputTokens: 3,
          cacheReadInputTokens: 5,
          inputTokens: 11,
          outputTokens: 7,
        },
      } as const;
    }

    const events = [];
    for await (const event of observeLlmStream(client, stream(), agent)) {
      events.push(event);
    }
    const toolResult = await observeToolExecution(
      "Bash",
      () => Promise.resolve({ output: "private tool output", isError: false }),
      agent,
    );
    endAgentTelemetry(agent, "completed");

    expect(events).toHaveLength(2);
    expect(toolResult.output).toBe("private tool output");
    expect(observations).toHaveLength(1);
    expect(observations[0]?.children.map((child) => child.kind)).toEqual([
      "generation",
      "tool",
    ]);
    expect(observations[0]?.ended).toBe(true);
    expect(observations[0]?.children.every((child) => child.ended)).toBe(true);
    expect(recordMetric).toHaveBeenCalledWith(
      "yukino.llm.tokens",
      "counter",
      11,
      expect.objectContaining({ "token.type": "input" }),
    );

    const exportedMetadata = JSON.stringify(observations);
    expect(exportedMetadata).not.toContain("private model output");
    expect(exportedMetadata).not.toContain("private tool output");
    expect(exportedMetadata).not.toContain("raw-session-id");
  });

  it("ends the generation when its consumer stops early", async () => {
    const { observations, runtime } = createFakeRuntime();
    vi.spyOn(telemetry, "getTelemetryRuntime").mockReturnValue(runtime);

    const client = fakeClient();
    const agent = startAgentTelemetry("", client);
    let sourceClosed = false;

    async function* stream() {
      try {
        await Promise.resolve();
        yield { type: "text_delta", text: "partial" } as const;
        yield {
          type: "stream_end",
          stopReason: "end_turn",
          usage: {
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            inputTokens: 1,
            outputTokens: 1,
          },
        } as const;
      } finally {
        sourceClosed = true;
      }
    }

    for await (const event of observeLlmStream(client, stream(), agent)) {
      expect(event.type).toBe("text_delta");
      break;
    }

    expect(sourceClosed).toBe(true);
    expect(observations[0]?.children[0]?.ended).toBe(true);
  });

  it("ends and marks a failed generation when the stream throws", async () => {
    const { observations, runtime } = createFakeRuntime();
    vi.spyOn(telemetry, "getTelemetryRuntime").mockReturnValue(runtime);

    const client = fakeClient();
    const agent = startAgentTelemetry("", client);
    const failure = new Error("provider failed");

    async function* stream() {
      await Promise.resolve();
      yield { type: "text_delta", text: "partial" } as const;
      throw failure;
    }

    const consume = async (): Promise<void> => {
      for await (const event of observeLlmStream(client, stream(), agent)) {
        expect(event.type).toBe("text_delta");
      }
    };

    await expect(consume()).rejects.toThrow("provider failed");
    const generation = observations[0]?.children[0];
    expect(generation?.error).toBe(failure);
    expect(generation?.ended).toBe(true);
  });
});
