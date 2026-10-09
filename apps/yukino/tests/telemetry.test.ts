import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Agent, type AgentConfig } from "@/agent/index.js";
import { ConversationManager } from "@/conversation/index.js";
import { HookEngine } from "@/hooks/index.js";
import type { LLMClient } from "@/llm/client.js";
import { ContextTooLongError, RateLimitError } from "@/llm/errors.js";
import { PermissionChecker } from "@/permissions/index.js";
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
import { ToolRegistry } from "@/tools/registry.js";

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
      yield {
        type: "stream_end",
        stopReason: "end_turn",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      };
    },
  };
}

function createAgent(
  client: LLMClient,
  overrides: Partial<AgentConfig> = {},
): Agent {
  const conversation = new ConversationManager();
  conversation.addUserMessage("task");
  return new Agent({
    client,
    conversation,
    registry: new ToolRegistry(),
    checker: new PermissionChecker(process.cwd(), "bypassPermissions"),
    cwd: process.cwd(),
    ...overrides,
  });
}

async function drain(agent: Agent): Promise<void> {
  for await (const _ of agent.run()) {
    /* observe terminal lifecycle */
  }
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

  it.each([
    new Error("provider failed"),
    new ContextTooLongError("context too long"),
    new RateLimitError("rate limited", "0"),
  ])("marks a terminal agent failure as error: %s", async (error) => {
    const { observations, recordMetric, runtime } = createFakeRuntime();
    vi.spyOn(telemetry, "getTelemetryRuntime").mockReturnValue(runtime);
    const client = fakeClient();
    client.stream = async function* () {
      yield await Promise.reject(error);
    };
    await drain(createAgent(client));
    expect(observations[0].ended).toBe(true);
    expect(observations[0].updates.at(-1)).toEqual({
      metadata: { outcome: "error" },
      level: "ERROR",
    });
    expect(recordMetric).toHaveBeenCalledWith(
      "yukino.agent.duration",
      "histogram",
      expect.any(Number),
      expect.objectContaining({ outcome: "error" }),
    );
  });

  it("marks an iteration-limit failure as error", async () => {
    const { observations, runtime } = createFakeRuntime();
    vi.spyOn(telemetry, "getTelemetryRuntime").mockReturnValue(runtime);
    const client = fakeClient();
    client.stream = async function* () {
      await Promise.resolve();
      yield {
        type: "tool_call_complete",
        toolId: "call",
        toolName: "Unknown",
        arguments: {},
      };
    };
    await drain(createAgent(client, { maxIterations: 1 }));
    expect(observations[0].updates.at(-1)?.metadata?.outcome).toBe("error");
  });

  it("marks a completed run as completed", async () => {
    const { observations, runtime } = createFakeRuntime();
    vi.spyOn(telemetry, "getTelemetryRuntime").mockReturnValue(runtime);
    await drain(createAgent(fakeClient()));
    expect(observations[0].updates.at(-1)?.metadata?.outcome).toBe("completed");
  });

  it("marks consumer-closed runs as interrupted and closes their generation", async () => {
    const { observations, runtime } = createFakeRuntime();
    vi.spyOn(telemetry, "getTelemetryRuntime").mockReturnValue(runtime);
    const client = fakeClient();
    client.stream = async function* () {
      await Promise.resolve();
      yield { type: "text_delta", text: "partial" };
    };
    for await (const event of createAgent(client).run()) {
      expect(event.type).toBe("stream_text");
      break;
    }
    expect(observations[0].updates.at(-1)?.metadata?.outcome).toBe(
      "interrupted",
    );
    expect(observations[0].ended).toBe(true);
    expect(observations[0].children.every((child) => child.ended)).toBe(true);
  });

  it("ends telemetry and runs session cleanup when a startup lifecycle hook throws", async () => {
    const { observations, runtime } = createFakeRuntime();
    vi.spyOn(telemetry, "getTelemetryRuntime").mockReturnValue(runtime);
    const hookEngine = new HookEngine([]);
    const hooks = vi
      .spyOn(hookEngine, "fire")
      .mockRejectedValueOnce(new Error("startup failed"));
    await expect(
      drain(createAgent(fakeClient(), { hookEngine })),
    ).rejects.toThrow("startup failed");
    expect(hooks).toHaveBeenLastCalledWith(
      "session_end",
      expect.anything(),
      expect.anything(),
    );
    expect(observations[0].updates.at(-1)?.metadata?.outcome).toBe("error");
    expect(observations[0].ended).toBe(true);
  });
});
