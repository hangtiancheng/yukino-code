import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentEvent } from "@/agent/events.js";
import {
  getExecutionContext,
  withExecutionContext,
  type ExecutionContext,
} from "@/cost/context.js";
import { createCostLedger } from "@/cost/ledger.js";
import type { LLMClient } from "@/llm/client.js";
import type { StreamEvent } from "@/llm/events.js";
import { createAgentRuntime } from "@/runtime/factory.js";
import { CUSTOM_PROVIDER } from "@/sdk/constants.js";
import { getSessionFilePath } from "@/session/records.js";
import { getYukinoDir, sessionPath } from "@/storage/index.js";
import type { Tool } from "@/tools/types.js";

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

function mockClient(withTool = false): LLMClient {
  let calls = 0;
  return {
    setSystemPrompt: () => undefined,
    async *stream(): AsyncGenerator<StreamEvent> {
      calls++;
      if (withTool && calls === 1) {
        yield {
          type: "tool_call_complete",
          toolId: "large",
          toolName: "Echo",
          arguments: {},
        };
        yield { type: "stream_end", stopReason: "tool_use", usage };
      } else {
        yield { type: "text_delta", text: "done" };
        yield { type: "stream_end", stopReason: "end_turn", usage };
      }
      await Promise.resolve();
    },
  };
}

describe("extracted headless runtime", () => {
  it("uses the real Agent loop without global process handlers or transcript persistence", async () => {
    const cwd = join(dirname(getYukinoDir()), "runtime-project");
    mkdirSync(cwd);
    const handlers = [
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
      process.listenerCount("exit"),
    ];
    const runtime = await createAgentRuntime({
      provider: CUSTOM_PROVIDER,
      cwd,
      client: mockClient(),
      persist: false,
      toolNames: [],
      loadProjectResources: false,
      memoryEnabled: false,
      enableCoordinatorMode: false,
      trackFileChanges: false,
    });
    const events: AgentEvent[] = [];
    try {
      for await (const event of runtime.run("first", {
        onPermissionRequest: () => Promise.resolve("deny"),
      })) {
        events.push(event);
      }
      expect(events).toContainEqual({ type: "stream_text", text: "done" });
      expect(events).toContainEqual({
        type: "loop_complete",
        stopReason: "end_turn",
      });
      expect(existsSync(getSessionFilePath(cwd, runtime.sessionId))).toBe(
        false,
      );
      expect(existsSync(join(getYukinoDir(), "activity.jsonl"))).toBe(false);
      expect([
        process.listenerCount("SIGINT"),
        process.listenerCount("SIGTERM"),
        process.listenerCount("exit"),
      ]).toEqual(handlers);
    } finally {
      await runtime.dispose();
    }
  });

  it("creates distinct standalone roots while preserving lazy SDK-inherited ownership", async () => {
    const cwd = join(dirname(getYukinoDir()), "runtime-project");
    mkdirSync(cwd);
    const seen: ExecutionContext[] = [];
    const raw = mockClient();
    const runtime = await createAgentRuntime({
      provider: CUSTOM_PROVIDER,
      cwd,
      client: {
        ...raw,
        async *stream(...args) {
          const context = getExecutionContext();
          if (!context) {
            throw new Error("Missing execution context");
          }
          seen.push(context);
          yield* raw.stream(...args);
        },
      },
      persist: false,
      toolNames: [],
      loadProjectResources: false,
      memoryEnabled: false,
      enableCoordinatorMode: false,
    });
    const callbacks = {
      onPermissionRequest: () => Promise.resolve("deny" as const),
    };
    const drain = async (iterator: AsyncGenerator) => {
      for await (const _event of iterator) {
        /* drain outside the owner's ALS */
      }
    };
    try {
      const initial = runtime.executionContext;
      await drain(runtime.run("first", callbacks));
      await drain(runtime.run("second", callbacks));
      expect(seen[0].runId).not.toBe(seen[1].runId);
      expect(seen[0].runId).not.toBe(initial?.runId);
      expect(seen.slice(0, 2).every((context) => !context.parentRunId)).toBe(
        true,
      );
      expect(seen[0].ledger).toBe(initial?.ledger);
      expect(seen[1].sessionId).toBe(seen[0].sessionId);
      const inherited = {
        ...seen[0],
        runId: "sdk-owned-turn",
        parentRunId: "sdk-parent",
        agentId: "sdk-agent",
        purpose: "teammate" as const,
      };
      const iterator = withExecutionContext(inherited, () =>
        runtime.run("SDK", callbacks),
      );
      await drain(iterator);
      expect(seen[2]).toEqual(inherited);
      await drain(runtime.run("standalone again", callbacks));
      expect(seen[3]).toMatchObject({ agentId: "main", purpose: "main" });
      expect(seen[3].parentRunId).toBeUndefined();
      const entries = seen[0].ledger.getEntries();
      expect(entries).toHaveLength(4);
      expect(new Set(entries.map((entry) => entry.runId)).size).toBe(4);
      for (const context of seen) {
        expect(context.ledger.summary({ runId: context.runId }).attempts).toBe(
          1,
        );
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("refreshes intentionally delegated standalone runs without losing their parent or role", async () => {
    const cwd = join(dirname(getYukinoDir()), "runtime-project");
    mkdirSync(cwd);
    const ledger = createCostLedger({ sessionId: "delegated-session" });
    const delegated: ExecutionContext = {
      sessionId: ledger.sessionId,
      runId: "delegated-template",
      parentRunId: "leader-turn",
      agentId: "worker",
      purpose: "teammate",
      ledger,
    };
    const seen: ExecutionContext[] = [];
    const raw = mockClient();
    const runtime = await createAgentRuntime({
      provider: CUSTOM_PROVIDER,
      cwd,
      executionContext: delegated,
      client: {
        ...raw,
        async *stream(...args) {
          const context = getExecutionContext();
          if (!context) {
            throw new Error("Missing execution context");
          }
          seen.push(context);
          yield* raw.stream(...args);
        },
      },
      persist: false,
      toolNames: [],
      loadProjectResources: false,
      memoryEnabled: false,
      enableCoordinatorMode: false,
    });
    const foreignLedger = createCostLedger({ sessionId: "foreign" });
    try {
      for (const prompt of ["first", "second"]) {
        const iterator = withExecutionContext(
          { ...delegated, sessionId: "foreign", ledger: foreignLedger },
          () =>
            runtime.run(prompt, {
              onPermissionRequest: () => Promise.resolve("deny"),
            }),
        );
        for await (const _event of iterator) {
          /* consume under no inherited context */
        }
      }
      expect(new Set(seen.map((context) => context.runId)).size).toBe(2);
      expect(seen.every((context) => context.runId !== delegated.runId)).toBe(
        true,
      );
      for (const context of seen) {
        expect(context).toMatchObject({
          sessionId: delegated.sessionId,
          parentRunId: delegated.parentRunId,
          agentId: delegated.agentId,
          purpose: delegated.purpose,
        });
        expect(context.ledger).toBe(ledger);
      }
      expect(
        ledger.summary({
          runId: delegated.parentRunId,
          includeDescendants: true,
        }).attempts,
      ).toBe(2);
      expect(foreignLedger.summary().attempts).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("owns large tool-output artifacts and removes them only after the run closes", async () => {
    const cwd = join(dirname(getYukinoDir()), "runtime-project");
    mkdirSync(cwd);
    const tool: Tool = {
      name: "Echo",
      description: "echo",
      category: "read",
      schema: () => ({
        name: "Echo",
        description: "echo",
        input_schema: { type: "object", properties: {} },
      }),
      execute: () =>
        Promise.resolve({
          output: "large output\n".repeat(30_000),
          isError: false,
        }),
    };
    const runtime = await createAgentRuntime({
      provider: CUSTOM_PROVIDER,
      cwd,
      client: mockClient(true),
      persist: false,
      tools: [tool],
      toolNames: ["Echo"],
      loadProjectResources: false,
      memoryEnabled: false,
      enableCoordinatorMode: false,
      trackFileChanges: false,
    });
    try {
      for await (const _event of runtime.run("large", {
        onPermissionRequest: () => Promise.resolve("deny"),
      })) {
        /* drain */
      }
      expect(existsSync(sessionPath(runtime.sessionId))).toBe(true);
      expect(existsSync(getSessionFilePath(cwd, runtime.sessionId))).toBe(
        false,
      );
    } finally {
      await runtime.dispose();
    }
    expect(existsSync(sessionPath(runtime.sessionId))).toBe(false);
  });
});
