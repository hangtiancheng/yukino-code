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

import { createHash } from "node:crypto";

import { getTelemetryRuntime, type TelemetryObservation } from "./index.js";

import type { LLMClient } from "@/llm/client.js";
import type { StreamEvent, UsageInfo } from "@/llm/events.js";
import type { ToolResult } from "@/tools/types.js";

interface LlmMetadata {
  model: string;
  protocol: string;
}

export interface AgentTelemetry {
  observation: TelemetryObservation;
  protocol: string;
  startedAt: number;
}

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
      runtime.recordMetric("yukino.llm.tokens", "counter", value, {
        ...attributes,
        "token.type": tokenType,
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
    ...(hashedSessionId ? { "session.hash": hashedSessionId } : {}),
  };
  runtime.recordMetric("yukino.agent.runs", "counter", 1, {
    protocol: metadata.protocol,
  });
  return {
    observation: runtime.startObservation(
      "agent",
      "yukino.agent.run",
      attributes,
    ),
    protocol: metadata.protocol,
    startedAt: performance.now(),
  };
}

export function endAgentTelemetry(
  telemetry: AgentTelemetry,
  outcome: "completed" | "interrupted",
): void {
  const runtime = getTelemetryRuntime();
  telemetry.observation.update({ metadata: { outcome } });
  telemetry.observation.end();
  runtime.recordMetric(
    "yukino.agent.duration",
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
    "generation",
    "yukino.llm.generate",
    attributes,
  );
  const startedAt = performance.now();
  let completionStartTime: Date | undefined;
  let outcome = "incomplete";

  runtime.recordMetric("yukino.llm.requests", "counter", 1, attributes);

  try {
    for await (const event of stream) {
      if (!completionStartTime && event.type !== "stream_end") {
        completionStartTime = new Date();
        runtime.recordMetric(
          "yukino.llm.time_to_first_token",
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
    runtime.emitLog("yukino.llm.error", "error", {
      "error.type": error instanceof Error ? error.name : typeof error,
      ...attributes,
    });
    throw error;
  } finally {
    observation.end();
    runtime.recordMetric(
      "yukino.llm.duration",
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
    "tool",
    "yukino.tool.execute",
    attributes,
  );
  const startedAt = performance.now();
  let outcome = "error";

  runtime.recordMetric("yukino.tool.calls", "counter", 1, attributes);

  try {
    const result = await operation();
    outcome = result.isError ? "error" : "completed";
    observation.update({
      level: result.isError ? "ERROR" : "DEFAULT",
      metadata: { outcome, tool: toolName },
      ...(result.isError ? { statusMessage: "Tool returned an error" } : {}),
    });
    return result;
  } catch (error) {
    observation.recordException(error);
    runtime.emitLog("yukino.tool.error", "error", {
      "error.type": error instanceof Error ? error.name : typeof error,
      tool: toolName,
    });
    throw error;
  } finally {
    observation.end();
    runtime.recordMetric(
      "yukino.tool.duration",
      "histogram",
      elapsedMilliseconds(startedAt),
      {
        outcome,
        tool: toolName,
      },
    );
  }
}
