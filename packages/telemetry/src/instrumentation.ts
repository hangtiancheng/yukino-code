import { createHash } from "node:crypto";

import type { LLMClient } from "@yukino.js/llm/client.js";
import type { StreamEvent, UsageInfo } from "@yukino.js/llm/events.js";
import {
  ATTRIBUTE_ERROR_TYPE,
  ATTRIBUTE_SESSION_HASH,
  ATTRIBUTE_TOKEN_TYPE,
  LOG_LLM_ERROR,
  LOG_TOOL_ERROR,
  METRIC_AGENT_DURATION,
  METRIC_AGENT_RUNS,
  METRIC_LLM_DURATION,
  METRIC_LLM_REQUESTS,
  METRIC_LLM_TIME_TO_FIRST_TOKEN,
  METRIC_LLM_TOKENS,
  METRIC_TOOL_CALLS,
  METRIC_TOOL_DURATION,
  OBSERVATION_AGENT_RUN,
  OBSERVATION_KIND_AGENT,
  OBSERVATION_KIND_GENERATION,
  OBSERVATION_KIND_TOOL,
  OBSERVATION_LEVEL_DEFAULT,
  OBSERVATION_LEVEL_ERROR,
  OBSERVATION_LLM_GENERATE,
  OBSERVATION_TOOL_EXECUTE,
  TOOL_ERROR_STATUS_MESSAGE,
} from "./constants.js";
import { getTelemetryRuntime, type TelemetryObservation } from "./index.js";
import type { ToolResult } from "@yukino.js/tools/types.js";

interface LlmMetadata {
  model: string;
  protocol: string;
}

export interface AgentTelemetry {
  observation: TelemetryObservation;
  protocol: string;
  startedAt: number;
}

export type AgentOutcome = "completed" | "interrupted" | "error";

const llmMetadata = new WeakMap<LLMClient, LlmMetadata>();

function elapsedMilliseconds(startedAt: number): number {
  return performance.now() - startedAt;
}

function sessionHash(sessionId: string): string | undefined {
  if (!sessionId) {
    return undefined;
  }
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

function metadataFor(client: LLMClient): LlmMetadata {
  return (
    llmMetadata.get(client) ?? {
      model: "unknown",
      protocol: client.protocol ?? "unknown",
    }
  );
}

function recordUsage(
  usage: UsageInfo,
  attributes: Record<string, string>,
): void {
  const runtime = getTelemetryRuntime();
  const values = {
    cache_creation: usage.cacheCreationInputTokens,
    cache_read: usage.cacheReadInputTokens,
    input: usage.inputTokens,
    output: usage.outputTokens,
  };
  for (const [tokenType, value] of Object.entries(values)) {
    if (value > 0) {
      runtime.recordMetric(METRIC_LLM_TOKENS, "counter", value, {
        ...attributes,
        [ATTRIBUTE_TOKEN_TYPE]: tokenType,
      });
    }
  }
}

export function registerLlmClient<T extends LLMClient>(
  client: T,
  metadata: LlmMetadata,
): T {
  llmMetadata.set(client, metadata);
  return client;
}

export function startAgentTelemetry(
  sessionId: string,
  client: LLMClient,
): AgentTelemetry {
  const runtime = getTelemetryRuntime();
  const metadata = metadataFor(client);
  const hashedSessionId = sessionHash(sessionId);
  const attributes = {
    protocol: metadata.protocol,
    ...(hashedSessionId ? { [ATTRIBUTE_SESSION_HASH]: hashedSessionId } : {}),
  };
  runtime.recordMetric(METRIC_AGENT_RUNS, "counter", 1, {
    protocol: metadata.protocol,
  });
  return {
    observation: runtime.startObservation(
      OBSERVATION_KIND_AGENT,
      OBSERVATION_AGENT_RUN,
      attributes,
    ),
    protocol: metadata.protocol,
    startedAt: performance.now(),
  };
}

export function endAgentTelemetry(
  telemetry: AgentTelemetry,
  outcome: AgentOutcome,
): void {
  const runtime = getTelemetryRuntime();
  telemetry.observation.update({
    metadata: { outcome },
    ...(outcome === "error" ? { level: OBSERVATION_LEVEL_ERROR } : {}),
  });
  telemetry.observation.end();
  runtime.recordMetric(
    METRIC_AGENT_DURATION,
    "histogram",
    elapsedMilliseconds(telemetry.startedAt),
    { outcome, protocol: telemetry.protocol },
  );
}

export async function* observeLlmStream(
  client: LLMClient,
  stream: AsyncGenerator<StreamEvent>,
  parent: AgentTelemetry,
): AsyncGenerator<StreamEvent> {
  const runtime = getTelemetryRuntime();
  const metadata = metadataFor(client);
  const attributes = {
    model: metadata.model,
    protocol: metadata.protocol,
  };
  const observation = parent.observation.startChild(
    OBSERVATION_KIND_GENERATION,
    OBSERVATION_LLM_GENERATE,
    attributes,
  );
  const startedAt = performance.now();
  let completionStartTime: Date | undefined;
  let outcome = "incomplete";

  runtime.recordMetric(METRIC_LLM_REQUESTS, "counter", 1, attributes);

  try {
    for await (const event of stream) {
      if (!completionStartTime && event.type !== "stream_end") {
        completionStartTime = new Date();
        runtime.recordMetric(
          METRIC_LLM_TIME_TO_FIRST_TOKEN,
          "histogram",
          elapsedMilliseconds(startedAt),
          attributes,
        );
      }

      if (event.type === "stream_end") {
        outcome = "completed";
        const usageDetails = {
          cacheCreationInput: event.usage.cacheCreationInputTokens,
          cacheReadInput: event.usage.cacheReadInputTokens,
          input: event.usage.inputTokens,
          output: event.usage.outputTokens,
        };
        observation.update({
          completionStartTime,
          metadata: {
            outcome,
            protocol: metadata.protocol,
            stopReason: event.stopReason,
          },
          model: metadata.model,
          usageDetails,
        });
        recordUsage(event.usage, attributes);
      }

      yield event;
    }
  } catch (error) {
    outcome = "error";
    observation.recordException(error);
    observation.update({ metadata: { outcome, protocol: metadata.protocol } });
    runtime.emitLog(LOG_LLM_ERROR, "error", {
      [ATTRIBUTE_ERROR_TYPE]:
        error instanceof Error ? error.name : typeof error,
      ...attributes,
    });
    throw error;
  } finally {
    observation.end();
    runtime.recordMetric(
      METRIC_LLM_DURATION,
      "histogram",
      elapsedMilliseconds(startedAt),
      {
        ...attributes,
        outcome,
      },
    );
  }
}

export async function observeToolExecution<T extends ToolResult>(
  toolName: string,
  operation: () => Promise<T>,
  parent: AgentTelemetry,
): Promise<T> {
  const runtime = getTelemetryRuntime();
  const attributes = { tool: toolName };
  const observation = parent.observation.startChild(
    OBSERVATION_KIND_TOOL,
    OBSERVATION_TOOL_EXECUTE,
    attributes,
  );
  const startedAt = performance.now();
  let outcome = "error";

  runtime.recordMetric(METRIC_TOOL_CALLS, "counter", 1, attributes);

  try {
    const result = await operation();
    outcome = result.isError ? "error" : "completed";
    observation.update({
      level: result.isError
        ? OBSERVATION_LEVEL_ERROR
        : OBSERVATION_LEVEL_DEFAULT,
      metadata: { outcome, tool: toolName },
      ...(result.isError ? { statusMessage: TOOL_ERROR_STATUS_MESSAGE } : {}),
    });
    return result;
  } catch (error) {
    observation.recordException(error);
    runtime.emitLog(LOG_TOOL_ERROR, "error", {
      [ATTRIBUTE_ERROR_TYPE]:
        error instanceof Error ? error.name : typeof error,
      tool: toolName,
    });
    throw error;
  } finally {
    observation.end();
    runtime.recordMetric(
      METRIC_TOOL_DURATION,
      "histogram",
      elapsedMilliseconds(startedAt),
      {
        outcome,
        tool: toolName,
      },
    );
  }
}
