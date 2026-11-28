import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { forceCompact } from "@/compact/compact.js";
import {
  ProviderConfigSchema,
  type ProviderConfig,
} from "@/config/provider-config.js";
import { ConversationManager } from "@/conversation/index.js";
import {
  getExecutionContext,
  withExecutionContext,
  type ExecutionContext,
} from "@/cost/context.js";
import { createCostLedger } from "@/cost/ledger.js";
import { measureClient, type LLMClient } from "@/llm/client.js";
import type { StreamEvent } from "@/llm/events.js";
import { MemoryConsolidator } from "@/memory/consolidation.js";
import { MemoryExtractor } from "@/memory/extractor.js";
import { MemoryManager } from "@/memory/manager.js";
import { createAgentRuntime } from "@/runtime/factory.js";
import { createAgentSession, type AgentSession } from "@/sdk/index.js";
import { getSessionFilePath } from "@/session/records.js";
import { getYukinoDir, projectPath, sessionPath } from "@/storage/index.js";
import { BUILTIN_AGENTS } from "@/subagent/constants.js";
import { spawnSubagent } from "@/subagent/spawn.js";
import { ToolRegistry } from "@/tools/registry.js";
import type { Tool } from "@/tools/types.js";
import { createYukinoBackend, YukinoWorkflowHost } from "@/workflow/backend.js";
import { createHostHandle } from "@/workflow/ports.js";

const sessions: AgentSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const usage = {
  inputTokens: 10,
  outputTokens: 2,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};
const end: StreamEvent = { type: "stream_end", stopReason: "end_turn", usage };
function provider(): ProviderConfig {
  return ProviderConfigSchema.parse({
    name: "fixture-provider",
    model: "opaque-model",
    protocol: "openai",
    api_key: "offline",
    base_url: "https://example.invalid",
    price: {
      currency: "USD",
      input: 10,
      output: 2,
      cache_read: 0.1,
      cache_write: 12,
      source: "fixture",
      effective_at: "2025-01-01T00:00:00Z",
    },
  });
}
function directory(): string {
  const cwd = join(dirname(getYukinoDir()), "billing-project");
  mkdirSync(cwd, { recursive: true });
  return cwd;
}
function owner(agentId = "leader"): ExecutionContext {
  const ledger = createCostLedger({ sessionId: "root", persist: false });
  return {
    sessionId: ledger.sessionId,
    runId: "leader-turn",
    agentId,
    purpose: "main",
    ledger,
  };
}
function client(seen: ExecutionContext[], text = "NONE"): LLMClient {
  return {
    setSystemPrompt() {},
    async *stream() {
      const context = getExecutionContext();
      if (!context) {
        throw new Error("Missing execution owner");
      }
      seen.push(context);
      await Promise.resolve();
      yield { type: "text_delta", text };
      yield end;
    },
  };
}
async function drain(iterator: AsyncGenerator): Promise<void> {
  for await (const _event of iterator) {
    /* consume actual iterator */
  }
}

async function session(
  options: Parameters<typeof createAgentSession>[0],
): Promise<AgentSession> {
  const result = await createAgentSession({
    cwd: directory(),
    persist: false,
    tools: [],
    ...options,
  });
  sessions.push(result.session);
  return result.session;
}

describe("root billing integration", () => {
  it("aggregates parallel SDK agents and their real delegated loops without double accounting", async () => {
    const config = provider();
    const seen: ExecutionContext[] = [];
    const delegated = new Set<string>();
    const raw: LLMClient = {
      setSystemPrompt() {},
      async *stream() {
        const context = getExecutionContext();
        if (!context) {
          throw new Error("Missing execution owner");
        }
        seen.push(context);
        await Promise.resolve();
        if (context.purpose === "main" && !delegated.has(context.runId)) {
          delegated.add(context.runId);
          yield {
            type: "tool_call_complete",
            toolId: "delegate",
            toolName: "Delegate",
            arguments: {},
          };
          yield { ...end, stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "done" };
          yield end;
        }
      },
    };
    const registry = new ToolRegistry();
    const measured = measureClient(raw, config);
    const delegate: Tool = {
      name: "Delegate",
      description: "delegate",
      category: "read",
      schema: () => ({
        name: "Delegate",
        description: "delegate",
        input_schema: { type: "object", properties: {} },
      }),
      execute: async (ctx) => {
        const outputs = await Promise.all(
          [false, true].map((background) =>
            spawnSubagent(
              BUILTIN_AGENTS[0],
              "child",
              measured,
              registry,
              config,
              ctx.cwd,
              undefined,
              undefined,
              undefined,
              ctx.permissionChecker,
              { persist: false, background },
            ),
          ),
        );
        return { output: outputs.join("\n"), isError: false };
      },
    };
    const a = await session({
      client: measured,
      provider: config,
      tools: [delegate],
    });
    const b = await session({
      client: measured,
      provider: config,
      tools: [delegate],
    });
    const results = await Promise.all([a.prompt("A"), b.prompt("B")]);
    expect(results.map((result) => result.status)).toEqual([
      "completed",
      "completed",
    ]);
    for (const host of [a, b]) {
      const entries = host.getCostEntries();
      expect(entries).toHaveLength(4);
      expect(
        entries.filter((entry) => entry.purpose === "subagent"),
      ).toHaveLength(2);
      const root = entries.find((entry) => entry.purpose === "main");
      expect(root).toBeDefined();
      expect(
        host.getStats({ runId: root?.runId, includeDescendants: true })
          .attempts,
      ).toBe(4);
      expect(host.getStats().estimated.USD.amount).toBeCloseTo(
        (4 * 104) / 1_000_000,
      );
      expect(entries.every((entry) => entry.sessionId === host.sessionId)).toBe(
        true,
      );
      expect(
        entries
          .filter((entry) => entry.purpose === "subagent")
          .every((entry) => entry.parentRunId === root?.runId),
      ).toBe(true);
    }
    expect(new Set(seen.map((context) => context.ledger)).size).toBe(2);
    await registry.dispose();
  });

  it("retains explicit teammate ownership across mailbox polling from another ALS context", async () => {
    const cwd = directory();
    const parent = owner();
    const foreign = owner("foreign");
    const seen: ExecutionContext[] = [];
    const runtime = await createAgentRuntime({
      provider: provider(),
      client: client(seen),
      cwd,
      persist: false,
      ledger: parent.ledger,
      registry: new ToolRegistry(),
      enableCoordinatorMode: false,
      memoryEnabled: false,
      loadProjectResources: false,
    });
    try {
      const tool = runtime.registry.get("Agent");
      expect(tool).toBeDefined();
      const result = await withExecutionContext(parent, () =>
        tool?.execute(
          { cwd, permissionChecker: runtime.checker },
          {
            kind: "teammate",
            description: "worker",
            prompt: "first task",
          },
        ),
      );
      expect(result?.isError).toBe(false);
      await vi.waitFor(() => {
        expect(parent.ledger.summary().attempts).toBe(1);
      });
      const team = runtime.teamManager.resolveTeam();
      expect(team).toBeDefined();
      await withExecutionContext(foreign, () =>
        team?.sendMessage("leader", "worker", "second task"),
      );
      await vi.waitFor(
        () => {
          expect(parent.ledger.summary().attempts).toBe(2);
        },
        { timeout: 4000 },
      );
      expect(seen).toHaveLength(2);
      expect(
        seen.every(
          (context) =>
            context.ledger === parent.ledger &&
            context.sessionId === "root" &&
            context.parentRunId === parent.runId &&
            context.purpose === "subagent",
        ),
      ).toBe(true);
      expect(seen[0].agentId).toBe(seen[1].agentId);
      expect(seen[0].runId).not.toBe(seen[1].runId);
      expect(foreign.ledger.summary().attempts).toBe(0);
      expect(
        parent.ledger.summary({ runId: parent.runId, includeDescendants: true })
          .attempts,
      ).toBe(2);
      expect(existsSync(sessionPath(seen[0].agentId, "transcript.jsonl"))).toBe(
        false,
      );
    } finally {
      await runtime.dispose();
    }
    expect(existsSync(sessionPath(seen[0].agentId))).toBe(false);
    expect(runtime.goalManager?.get()).toBeNull();
  });

  it("auto-compacts a real delegated loop as a child of the delegated run", async () => {
    const parent = owner();
    const seen: ExecutionContext[] = [];
    const config = ProviderConfigSchema.parse({
      ...provider(),
      context_window: 12000,
      max_output_tokens: 1000,
    });
    const conv = new ConversationManager();
    for (let i = 0; i < 10; i++) {
      conv.addUserMessage("prefix".repeat(2000));
    }
    for (let i = 0; i < 6; i++) {
      conv.addUserMessage(`recent ${i}`);
    }
    const registry = new ToolRegistry();
    await withExecutionContext(parent, () =>
      spawnSubagent(
        BUILTIN_AGENTS[0],
        "task",
        measureClient(client(seen), config),
        registry,
        config,
        directory(),
        undefined,
        undefined,
        undefined,
        undefined,
        { persist: false, contextSnapshot: conv },
      ),
    );
    expect(seen.map((context) => context.purpose)).toEqual([
      "compaction",
      "subagent",
    ]);
    expect(seen[0].parentRunId).toBe(seen[1].runId);
    expect(seen[0].agentId).toBe(seen[1].agentId);
    expect(seen[1].parentRunId).toBe(parent.runId);
    expect(
      parent.ledger.summary({ runId: parent.runId, includeDescendants: true })
        .attempts,
    ).toBe(2);
    await registry.dispose();
  });

  it("keeps independent memory helpers ephemeral when no owner is bound", async () => {
    const seen: ExecutionContext[] = [];
    const extractor = new MemoryExtractor(
      measureClient(client(seen), provider()),
      directory(),
    );
    try {
      await extractor.extract("standalone summary");
      expect(seen).toHaveLength(1);
      expect(seen[0].purpose).toBe("memory");
      expect(seen[0].parentRunId).toBeUndefined();
      expect(seen[0].ledger.path).toBeUndefined();
      expect(seen[0].sessionId).toBe(seen[0].ledger.sessionId);
    } finally {
      await extractor.dispose();
    }
  });

  it("keeps independent compaction helpers ephemeral and correctly attributed", async () => {
    const seen: ExecutionContext[] = [];
    const conv = new ConversationManager();
    for (let i = 0; i < 10; i++) {
      conv.addUserMessage(`message ${i}`);
      conv.addAssistantFull(`reply ${i}`, [], []);
    }
    expect(
      (
        await forceCompact(
          conv,
          measureClient(client(seen), provider()),
          null,
          [],
          [],
        )
      ).compacted,
    ).toBe(true);
    expect(seen[0].purpose).toBe("compaction");
    expect(seen[0].parentRunId).toBeUndefined();
    expect(seen[0].ledger.path).toBeUndefined();
    expect(seen[0].ledger.summary().attempts).toBe(1);
  });

  it("includes paid backend children through unbilled workflow ancestors without extra attempts", async () => {
    const root = owner();
    const workflow = {
      ...root,
      runId: "workflow-owner",
      parentRunId: root.runId,
      purpose: "workflow" as const,
    };
    const seen: ExecutionContext[] = [];
    const registry = new ToolRegistry();
    const config = provider();
    const backend = createYukinoBackend({
      registry,
      getClient: () => measureClient(client(seen, "done"), config),
      getProvider: () => config,
    });
    const host = withExecutionContext(root, () =>
      createHostHandle(
        new YukinoWorkflowHost({ cwd: directory() }, workflow, false),
      ),
    );
    try {
      const result = await backend.run(
        { prompt: "workflow task" },
        {
          host,
          signal: new AbortController().signal,
          runId: "backend-workflow-run",
          agentId: 1,
        },
      );
      expect(result).toMatchObject({ kind: "ok", output: "done" });
      expect(seen).toHaveLength(1);
      expect(root.ledger.getEntries()).toHaveLength(1);
      expect(root.ledger.getEntries()[0]).toMatchObject({
        runId: seen[0].runId,
        parentRunId: "backend-workflow-run",
        purpose: "workflow",
        sessionId: root.sessionId,
      });
      const total = root.ledger.summary();
      expect(total).toMatchObject({ attempts: 1, requests: 1, usage });
      for (const runId of [
        root.runId,
        workflow.runId,
        "backend-workflow-run",
      ]) {
        expect(
          root.ledger.summary({ runId, includeDescendants: true }),
        ).toEqual(total);
        expect(root.ledger.summary({ runId }).attempts).toBe(0);
      }
    } finally {
      await registry.dispose();
    }
  });

  it("charges workflow delegation to the root ledger rather than a child session", async () => {
    const parent = { ...owner(), purpose: "workflow" as const };
    const seen: ExecutionContext[] = [];
    const registry = new ToolRegistry();
    await withExecutionContext(parent, () =>
      spawnSubagent(
        BUILTIN_AGENTS[0],
        "workflow task",
        measureClient(client(seen), provider()),
        registry,
        provider(),
        directory(),
        undefined,
        undefined,
        undefined,
        undefined,
        { persist: false },
      ),
    );
    expect(parent.ledger.getEntries()[0]).toMatchObject({
      purpose: "workflow",
      parentRunId: parent.runId,
      sessionId: "root",
    });
    expect(seen[0].agentId).not.toBe("root");
    expect(
      parent.ledger.summary({ runId: parent.runId, includeDescendants: true })
        .attempts,
    ).toBe(1);
    await registry.dispose();
  });

  it("attributes selector, extraction, consolidation and compaction without transcripts or exit listeners", async () => {
    const cwd = directory();
    const memDir = projectPath(cwd, "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      join(memDir, "fixture.md"),
      "---\nname: fixture\ndescription: fixture\ntype: project\n---\nfixture memory\n",
    );
    const parent = owner();
    const seen: ExecutionContext[] = [];
    const measured = measureClient(client(seen), provider());
    const extractor = new MemoryExtractor(measured, cwd);
    const consolidator = new MemoryConsolidator(measured, cwd);
    const handlers = ["SIGINT", "SIGTERM", "exit"].map((signal) =>
      process.listenerCount(signal),
    );
    try {
      await withExecutionContext(parent, async () => {
        await new MemoryManager(cwd).findRelevantMemories("fixture", measured);
        await extractor.extract("conversation summary");
        await consolidator.run(memDir, []);
        const conv = new ConversationManager();
        for (let i = 0; i < 10; i++) {
          conv.addUserMessage(`message ${i}`);
          conv.addAssistantFull(`reply ${i}`, [], []);
        }
        expect(
          (await forceCompact(conv, measured, null, [], [])).compacted,
        ).toBe(true);
      });
      expect(seen.map((context) => context.purpose)).toEqual([
        "memory",
        "memory",
        "memory",
        "compaction",
      ]);
      expect(
        seen.every(
          (context) =>
            context.ledger === parent.ledger &&
            context.agentId === parent.agentId &&
            context.parentRunId === parent.runId,
        ),
      ).toBe(true);
      expect(new Set(seen.map((context) => context.runId)).size).toBe(4);
      expect(
        parent.ledger.summary({
          runId: parent.runId,
          includeDescendants: true,
        }),
      ).toMatchObject({
        attempts: 4,
        usage: { inputTokens: 40, outputTokens: 8 },
      });
      expect(parent.ledger.summary().estimated.USD.amount).toBeCloseTo(
        416 / 1_000_000,
      );
      expect(
        ["SIGINT", "SIGTERM", "exit"].map((signal) =>
          process.listenerCount(signal),
        ),
      ).toEqual(handlers);
    } finally {
      await Promise.all([extractor.dispose(), consolidator.dispose()]);
    }
  });

  it("keeps the latest queued memory request's owner instead of the draining request's ALS", async () => {
    const a = owner("A");
    const b = { ...a, runId: "second-turn", agentId: "B" };
    const seen: ExecutionContext[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const raw: LLMClient = {
      setSystemPrompt() {},
      async *stream() {
        const context = getExecutionContext();
        if (!context) {
          throw new Error("Missing execution owner");
        }
        seen.push(context);
        if (seen.length === 1) {
          await gate;
        }
        yield { type: "text_delta", text: "NONE" };
        yield end;
      },
    };
    const extractor = new MemoryExtractor(
      measureClient(raw, provider()),
      directory(),
    );
    try {
      const first = withExecutionContext(a, () => extractor.extract("A"));
      await vi.waitFor(() => {
        expect(seen).toHaveLength(1);
      });
      await withExecutionContext(b, () => extractor.extract("B"));
      release();
      await first;
      expect(
        seen.map((context) => [context.agentId, context.parentRunId]),
      ).toEqual([
        ["A", a.runId],
        ["B", b.runId],
      ]);
    } finally {
      release();
      await extractor.dispose();
    }
  });

  it("binds a runtime iterator consumed outside ALS and rejects nonpersistent Goals without writes", async () => {
    const parent = owner();
    const seen: ExecutionContext[] = [];
    const runtime = await createAgentRuntime({
      provider: provider(),
      client: client(seen),
      cwd: directory(),
      persist: false,
      ledger: parent.ledger,
      enableCoordinatorMode: false,
      memoryEnabled: false,
      loadProjectResources: false,
      toolNames: [],
    });
    try {
      const iterator = withExecutionContext(parent, () =>
        runtime.run("prompt", {
          onPermissionRequest: () => Promise.resolve("deny"),
        }),
      );
      await drain(iterator);
      expect(seen[0]).toMatchObject({
        runId: parent.runId,
        sessionId: parent.sessionId,
      });
      await expect(
        drain(
          runtime.run("/goal test", {
            onPermissionRequest: () => Promise.resolve("deny"),
          }),
        ),
      ).resolves.toBeUndefined();
      expect(
        existsSync(getSessionFilePath(runtime.cwd, runtime.sessionId)),
      ).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("SDK warming owner wiring", () => {
  it("makes no auxiliary calls by default, or after explicit stop and disposal", async () => {
    vi.useFakeTimers();
    const seen: ExecutionContext[] = [];
    const host = await session({
      client: client(seen),
      provider: provider(),
      systemPrompt: "system",
    });
    await host.prompt("foreground");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(seen).toHaveLength(1);
    await host.stopWarming();
    host.resumeWarming();
    await vi.advanceTimersByTimeAsync(10_000);
    await host.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(seen).toHaveLength(1);
    expect(host.getStats().attempts).toBe(1);
  });

  it("warms only verified replayable metadata, charges the same ledger and cancels future calls", async () => {
    vi.useFakeTimers();
    const config = ProviderConfigSchema.parse({
      ...provider(),
      cache: {
        mode: "short",
        capabilities: {
          verified: true,
          mapping: "openai_retention",
          short: { ttl_seconds: 300, min_tokens: 10 },
          replayable: true,
        },
      },
      warming: {
        mode: "idle",
        reuse_probability: 1,
        frequency_ms: 10,
        max_idle_ms: 1000,
        net_benefit_threshold: 0,
      },
    });
    const seen: ExecutionContext[] = [];
    const raw: LLMClient = {
      supportsCacheWarming: true,
      setSystemPrompt() {},
      async *stream(_conv, _tools, _signal, options) {
        const context = getExecutionContext();
        if (!context) {
          throw new Error("Missing execution owner");
        }
        seen.push(context);
        await Promise.resolve();
        if (options?.warming) {
          expect(options).toMatchObject({
            maxRetries: 0,
            maxOutputTokens: 1,
            warming: true,
          });
        }
        yield { type: "text_delta", text: "done" };
        yield {
          type: "stream_end",
          stopReason: "end_turn",
          usage: {
            inputTokens: 0,
            outputTokens: 1,
            cacheReadInputTokens: 1000,
            cacheCreationInputTokens: 0,
          },
        };
      },
    };
    const host = await session({
      provider: config,
      client: raw,
      systemPrompt: "system",
    });
    await host.prompt("foreground");
    const messages = host.getMessages();
    await vi.advanceTimersByTimeAsync(10);
    expect(seen.map((context) => context.purpose)).toEqual([
      "main",
      "cache_warming",
    ]);
    expect(seen[1].ledger).toBe(seen[0].ledger);
    expect(seen[1].parentRunId).toBe(seen[0].runId);
    expect(
      host.getStats({ runId: seen[0].runId, includeDescendants: true })
        .attempts,
    ).toBe(2);
    expect(host.getCostEntries({ purpose: "cache_warming" })).toHaveLength(1);
    expect(host.getMessages()).toEqual(messages);
    await host.stopWarming();
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toHaveLength(2);
    await host.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toHaveLength(2);
  });
});
