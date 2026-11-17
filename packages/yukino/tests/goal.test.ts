import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "@/agent/events.js";
import { Agent } from "@/agent/index.js";
import { ConversationManager } from "@/conversation/index.js";
import { MAX_GOAL_TURNS } from "@/goal/constants.js";
import { GoalManager, handleGoalCommand } from "@/goal/index.js";
import { HookEngine } from "@/hooks/index.js";
import type { LLMClient } from "@/llm/client.js";
import { ContextTooLongError, RateLimitError } from "@/llm/errors.js";
import type { StreamEvent } from "@/llm/events.js";
import { PermissionChecker } from "@/permissions/index.js";
import {
  loadSession,
  rebuildFromSession,
  saveCompactBoundary,
  sessionLineCount,
  getSessionFilePath,
  truncateSessionLines,
} from "@/session/index.js";
import { filterToolsForAgent } from "@/subagent/tool-filter.js";
import { GoalTool } from "@/tools/goal.js";
import { ToolRegistry } from "@/tools/registry.js";
import type { ProviderToolSchema } from "@/tools/types.js";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "yukino-goal-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(cwd, { recursive: true, force: true });
});
const end: StreamEvent = {
  type: "stream_end",
  stopReason: "end_turn",
  usage: {
    inputTokens: 2,
    outputTokens: 3,
    cacheReadInputTokens: 4,
    cacheCreationInputTokens: 5,
  },
};
class Client implements LLMClient {
  calls = 0;
  snapshots: string[] = [];
  toolCounts: number[] = [];
  constructor(
    private scripts: StreamEvent[][],
    private callback?: (call: number) => void,
  ) {}
  setSystemPrompt = vi.fn();
  async *stream(
    conversation: ConversationManager,
    tools: ProviderToolSchema[],
  ): AsyncGenerator<StreamEvent> {
    this.snapshots.push(JSON.stringify(conversation.getMessages()));
    this.toolCounts.push(tools.length);
    const script = this.scripts[this.calls++] ?? [end];
    this.callback?.(this.calls);
    await Promise.resolve();
    yield* script;
  }
}
async function run(
  manager: GoalManager,
  client: LLMClient,
  options: {
    mode?: "plan";
    signal?: AbortSignal;
    shouldContinue?: () => boolean;
    hooks?: HookEngine;
    onAgent?: (agent: Agent) => void;
  } = {},
) {
  const registry = new ToolRegistry();
  registry.register(new GoalTool());
  const conversation = new ConversationManager();
  conversation.addUserMessage("Work on the requested goal");
  const agent = new Agent({
    client,
    registry,
    conversation,
    cwd,
    sessionId: manager.sessionId,
    goalManager: manager,
    checker: new PermissionChecker(cwd, options.mode ?? "bypassPermissions"),
    abortSignal: options.signal,
    shouldContinueGoal: options.shouldContinue,
    hookEngine: options.hooks,
  });
  options.onAgent?.(agent);
  const events: AgentEvent[] = [];
  for await (const event of agent.run()) {
    events.push(event);
  }
  return { events, conversation, agent };
}
const complete: StreamEvent = {
  type: "tool_call_complete",
  toolId: "complete",
  toolName: "Goal",
  arguments: {
    action: "update",
    status: "complete",
    reason: "All requested work verified",
  },
};

describe("persistent goals", () => {
  it.each(["active", "paused"])(
    "explains why the agent cannot set goal status %s without changing state",
    async (status) => {
      const manager = new GoalManager(cwd, "one");
      manager.set("Finish");
      const before = manager.get();
      const result = await new GoalTool().execute(
        { cwd, goalManager: manager },
        { action: "update", status, reason: "Start work" },
      );
      expect(result.isError).toBe(true);
      expect(result.output).toContain(
        "Goal update accepts only 'in_progress', 'complete', or 'blocked'",
      );
      expect(result.output).toContain("active as soon as the user sets it");
      expect(result.output).not.toContain("invalid_value");
      expect(manager.get()).toEqual(before);
    },
  );
  it("reports in_progress, persists a fresh blocker audit, and keeps tracking active work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const manager = new GoalManager(cwd, "one");
    manager.set("Finish", 100);
    manager.beginTurn();
    manager.addTokens(14);
    manager.update("blocked", "Service unavailable");
    manager.beginTurn();
    manager.update("blocked", "Service unavailable");
    expect(manager.get()?.blockedAttempts).toBe(2);
    vi.advanceTimersByTime(3000);
    const tool = new GoalTool();
    expect(tool.schema().input_schema.properties?.status).toMatchObject({
      enum: ["in_progress", "complete", "blocked"],
    });
    const result = await tool.execute(
      { cwd, goalManager: manager },
      { action: "update", status: "in_progress", reason: "Service recovered" },
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain("Status: active");
    expect(new GoalManager(cwd, "one").get()).toMatchObject({
      status: "active",
      tokenBudget: 100,
      tokensUsed: 14,
      turnsExecuted: 2,
      activeMs: 3000,
      blockedAttempts: 0,
      lastBlockReason: null,
      lastBlockedTurn: null,
    });
    expect(manager.continuation()).toContain("Finish");
    vi.advanceTimersByTime(2000);
    manager.addTokens(14);
    manager.endRun();
    expect(manager.get()).toMatchObject({ activeMs: 5000, tokensUsed: 28 });
    manager.beginTurn();
    manager.update("blocked", "Service unavailable");
    expect(manager.get()?.blockedAttempts).toBe(1);
  });
  it.each([
    "paused",
    "blocked",
    "complete",
    "budget_limited",
    "max_turns",
  ] as const)(
    "does not let in_progress reactivate a %s goal",
    async (status) => {
      const manager = new GoalManager(cwd, "one");
      manager.set("Finish");
      manager.transition(status);
      const before = manager.get();
      const result = await new GoalTool().execute(
        { cwd, goalManager: manager },
        { action: "update", status: "in_progress", reason: "More work" },
      );
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Only an active goal can be updated");
      expect(manager.get()).toEqual(before);
    },
  );
  it("keeps goal validation strict and tells the model that goals are user-set", async () => {
    const manager = new GoalManager(cwd, "one");
    const tool = new GoalTool();
    expect(
      (await tool.execute({ cwd, goalManager: manager }, { action: "get" }))
        .output,
    ).toContain("Only the user can set one");
    for (const args of [
      { action: "set", objective: "Finish" },
      { action: "update", status: "complete", reason: " " },
      { action: "update", status: "in_progress", reason: " " },
      { action: "get", unexpected: true },
    ]) {
      const result = await tool.execute({ cwd, goalManager: manager }, args);
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Goal expects");
      expect(result.output).not.toContain("invalid_");
    }
    expect(manager.get()).toBeNull();
    const progress = await tool.execute(
      { cwd, goalManager: manager },
      { action: "update", status: "in_progress", reason: "Start work" },
    );
    expect(progress.isError).toBe(true);
    expect(manager.get()).toBeNull();
  });
  it("persists a session-local goal through compaction and a clear tombstone", () => {
    const manager = new GoalManager(cwd, "one");
    manager.set("Implement and verify", 100);
    manager.beginTurn();
    manager.addTokens(14);
    manager.endRun();
    saveCompactBoundary(cwd, "one", { summary: "context", keep: [] });
    expect(new GoalManager(cwd, "one").get()).toMatchObject({
      objective: "Implement and verify",
      tokensUsed: 14,
    });
    expect(new GoalManager(cwd, "two").get()).toBeNull();
    expect(
      JSON.stringify(rebuildFromSession(loadSession(cwd, "one"))),
    ).not.toContain("goal_state");
    manager.clear();
    expect(new GoalManager(cwd, "one").get()).toBeNull();
  });
  it("restores goal state from the rewound transcript", () => {
    const manager = new GoalManager(cwd, "one");
    manager.set("First");
    const path = getSessionFilePath(cwd, "one");
    const lines = sessionLineCount(path);
    manager.set("Second", null, true);
    if (lines === undefined) {
      throw new Error("Expected persisted transcript");
    }
    truncateSessionLines(path, lines);
    expect(new GoalManager(cwd, "one").get()?.objective).toBe("First");
  });
  it("requires an explicit replacement and validates a finite positive budget", () => {
    const manager = new GoalManager(cwd, "one");
    expect(
      handleGoalCommand(manager, "--budget 100 Implement x").prompt,
    ).toContain("Implement x");
    expect(handleGoalCommand(manager, "Implement y").message).toContain(
      "unfinished goal",
    );
    expect(handleGoalCommand(manager, "replace Implement y").prompt).toContain(
      "Implement y",
    );
    expect(
      handleGoalCommand(manager, "replace --budget 0 Invalid").message,
    ).toContain("Error:");
    expect(manager.get()?.objective).toBe("Implement y");
  });
  it("counts active runtime while excluding idle, paused, and restart intervals", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const manager = new GoalManager(cwd, "one");
    manager.set("Task");
    vi.advanceTimersByTime(1000);
    manager.beginTurn();
    vi.advanceTimersByTime(3000);
    manager.endRun();
    manager.transition("paused");
    vi.advanceTimersByTime(9000);
    manager.resume();
    manager.beginTurn();
    vi.advanceTimersByTime(2000);
    manager.endRun();
    expect(manager.get()?.activeMs).toBe(5000);
    vi.advanceTimersByTime(9000);
    expect(new GoalManager(cwd, "one").get()?.activeMs).toBe(5000);
  });
  it("continues across end-turn responses and allows the model to finish a verified goal", async () => {
    const manager = new GoalManager(cwd, "one");
    manager.set("Finish");
    const client = new Client([
      [{ type: "text_delta", text: "More work remains" }, end],
      [complete, end],
      [{ type: "text_delta", text: "Verified" }, end],
    ]);
    const { events } = await run(manager, client);
    expect(client.calls).toBe(3);
    expect(manager.get()).toMatchObject({
      status: "complete",
      turnsExecuted: 2,
      tokensUsed: 42,
    });
    expect(
      events.filter((event) => event.type === "loop_complete"),
    ).toHaveLength(1);
    expect(client.snapshots[1]).toContain(
      "Continue working toward the persistent goal",
    );
  });
  it("accounts for cache tokens and summarizes once without executing pending tools at the budget", async () => {
    const manager = new GoalManager(cwd, "one");
    manager.set("Finish", 10);
    const client = new Client([
      [complete, end],
      [{ type: "text_delta", text: "Verification remains unfinished." }, end],
    ]);
    const { events, conversation } = await run(manager, client);
    expect(client.calls).toBe(2);
    expect(client.toolCounts).toEqual([1, 0]);
    expect(client.snapshots[1]).toContain("<goal-budget-limit>");
    expect(manager.get()).toMatchObject({
      status: "budget_limited",
      tokensUsed: 28,
      turnsExecuted: 1,
      budgetSummaryPending: false,
    });
    expect(
      conversation.getMessages().find((message) => message.toolResults)
        ?.toolResults?.[0].isError,
    ).toBe(true);
    expect(events.at(-1)).toEqual({
      type: "loop_complete",
      stopReason: "budget_limited",
    });
    expect(handleGoalCommand(manager, "pause").message).toContain("Error:");
    expect(handleGoalCommand(manager, "resume").message).toContain("Error:");
  });
  it("counts an in-flight request after pause without counting later idle usage", () => {
    const manager = new GoalManager(cwd, "one");
    manager.set("Task");
    manager.beginTurn();
    manager.transition("paused");
    manager.addTokens(14);
    manager.endRun();
    manager.addTokens(14);
    expect(manager.get()).toMatchObject({ status: "paused", tokensUsed: 14 });
  });
  it("reports budget exhaustion when a response has no tools", async () => {
    const manager = new GoalManager(cwd, "one");
    manager.set("Task", 10);
    const { events } = await run(manager, new Client([[end]]));
    expect(events.at(-1)).toEqual({
      type: "loop_complete",
      stopReason: "budget_limited",
    });
    expect(
      events.some(
        (event) =>
          event.type === "stream_text" &&
          event.text.includes("Status: budget_limited"),
      ),
    ).toBe(true);
  });
  it("rejects tool calls in the final summary and does not recover an output-limited summary", async () => {
    const manager = new GoalManager(cwd, "one");
    manager.set("Finish", 10);
    const client = new Client([
      [end],
      [complete, { ...end, stopReason: "max_tokens" }],
    ]);
    const { events, conversation } = await run(manager, client);
    expect(client.calls).toBe(2);
    expect(client.toolCounts[1]).toBe(0);
    expect(manager.get()?.status).toBe("budget_limited");
    expect(conversation.getMessages().at(-1)?.toolResults?.[0]).toMatchObject({
      isError: true,
    });
    expect(events.some((event) => event.type === "retry")).toBe(false);
  });
  it("does not recover an output-limited response after the goal budget is exhausted", async () => {
    const manager = new GoalManager(cwd, "one");
    manager.set("Finish", 10);
    const client = new Client([
      [{ ...end, stopReason: "max_tokens" }],
      [{ type: "text_delta", text: "Unfinished work remains." }, end],
    ]);
    const { events } = await run(manager, client);
    expect(client.calls).toBe(2);
    expect(events.some((event) => event.type === "retry")).toBe(false);
  });
  it("persists a deferred budget summary and counts it once across session resume", async () => {
    const manager = new GoalManager(cwd, "one");
    manager.set("Finish", 10);
    const initial = new Client([[end]]);
    await run(manager, initial, { shouldContinue: () => false });
    expect(initial.calls).toBe(1);
    expect(manager.get()?.budgetSummaryPending).toBe(true);
    const restored = new GoalManager(cwd, "one");
    const summary = new Client([
      [{ type: "text_delta", text: "Pending: finish verification." }, end],
    ]);
    await run(restored, summary);
    expect(summary.calls).toBe(1);
    expect(summary.toolCounts).toEqual([0]);
    expect(restored.get()).toMatchObject({
      tokensUsed: 28,
      budgetSummaryPending: false,
    });
    const replay = rebuildFromSession(loadSession(cwd, "one"));
    expect(JSON.stringify(replay)).toContain("Pending: finish verification.");
    const repeat = new Client([[end]]);
    await run(new GoalManager(cwd, "one"), repeat);
    expect(repeat.calls).toBe(0);
  });
  it.each(["plan", "interrupted"])(
    "leaves a budget summary pending when %s owns the turn",
    async (gate) => {
      const manager = new GoalManager(cwd, "one");
      manager.set("Finish", 10);
      manager.beginTurn();
      manager.addTokens(14);
      manager.endRun();
      const controller = new AbortController();
      if (gate === "interrupted") {
        controller.abort();
      }
      const client = new Client([[end]]);
      await run(manager, client, {
        mode: gate === "plan" ? "plan" : undefined,
        signal: controller.signal,
      });
      expect(client.calls).toBe(0);
      expect(new GoalManager(cwd, "one").get()?.budgetSummaryPending).toBe(
        true,
      );
    },
  );
  it("preserves the summary opportunity when user input arrives before dispatch", async () => {
    const manager = new GoalManager(cwd, "one");
    manager.set("Finish", 10);
    manager.beginTurn();
    manager.addTokens(14);
    manager.endRun();
    const client = new Client([[end]]);
    let checks = 0;
    const { conversation } = await run(manager, client, {
      shouldContinue: () => ++checks === 1,
    });
    expect(client.calls).toBe(0);
    expect(JSON.stringify(conversation.getMessages())).not.toContain(
      "<goal-budget-limit>",
    );
    expect(new GoalManager(cwd, "one").get()?.budgetSummaryPending).toBe(true);
  });
  it.each([
    { toolCalls: false, followUpGuard: false },
    { toolCalls: true, followUpGuard: false },
    { toolCalls: false, followUpGuard: true },
    { toolCalls: true, followUpGuard: true },
  ])(
    "defers the summary for queued steering (tools=$toolCalls, follow-up guard=$followUpGuard)",
    async ({ toolCalls, followUpGuard }) => {
      const manager = new GoalManager(cwd, "one");
      manager.set("Finish", 10);
      let inFlight: Agent | undefined;
      const client = new Client(
        [toolCalls ? [complete, end] : [end]],
        (call) => {
          if (call === 1) {
            inFlight?.steer("Stop and explain the current diff.");
            inFlight?.steer("Keep the files untouched.");
          }
        },
      );
      const { agent, events, conversation } = await run(manager, client, {
        shouldContinue: followUpGuard ? () => true : undefined,
        onAgent: (value) => {
          inFlight = value;
        },
      });
      expect(client.calls).toBe(1);
      expect(agent.drainSteering().map((message) => message.text)).toEqual([
        "Stop and explain the current diff.",
        "Keep the files untouched.",
      ]);
      expect(events.some((event) => event.type === "steering_delivered")).toBe(
        false,
      );
      expect(JSON.stringify(conversation.getMessages())).not.toContain(
        "<goal-budget-limit>",
      );
      expect(new GoalManager(cwd, "one").get()?.budgetSummaryPending).toBe(
        true,
      );
    },
  );
  it("rechecks queued steering after pre-send hooks before consuming the summary", async () => {
    const manager = new GoalManager(cwd, "one");
    manager.set("Finish", 10);
    manager.beginTurn();
    manager.addTokens(14);
    manager.endRun();
    const hooks = new HookEngine([]);
    let inFlight: Agent | undefined;
    vi.spyOn(hooks, "fire").mockImplementation(async (event) => {
      await Promise.resolve();
      if (event === "pre_send") {
        inFlight?.steer("Pause and read my correction first.");
      }
      return [];
    });
    const client = new Client([[end]]);
    const { agent, conversation } = await run(manager, client, {
      hooks,
      onAgent: (value) => {
        inFlight = value;
      },
    });
    expect(client.calls).toBe(0);
    expect(agent.drainSteering().map((message) => message.text)).toEqual([
      "Pause and read my correction first.",
    ]);
    expect(JSON.stringify(conversation.getMessages())).not.toContain(
      "<goal-budget-limit>",
    );
    expect(new GoalManager(cwd, "one").get()?.budgetSummaryPending).toBe(true);
  });
  it("retains steering submitted during an already dispatched summary", async () => {
    const manager = new GoalManager(cwd, "one");
    manager.set("Finish", 10);
    let inFlight: Agent | undefined;
    const client = new Client([[end], [end]], (call) => {
      if (call === 2) {
        inFlight?.steer("Review my follow-up next.");
      }
    });
    const { agent } = await run(manager, client, {
      onAgent: (value) => {
        inFlight = value;
      },
    });
    expect(client.calls).toBe(2);
    expect(agent.drainSteering().map((message) => message.text)).toEqual([
      "Review my follow-up next.",
    ]);
    expect(manager.get()?.budgetSummaryPending).toBe(false);
  });
  it("does not let a final summary execute tools or continue a replacement goal", async () => {
    const manager = new GoalManager(cwd, "one");
    manager.set("Old objective", 10);
    const client = new Client([[end], [complete, end]], (call) => {
      if (call === 2) {
        manager.set("New objective", null, true);
      }
    });
    const { conversation } = await run(manager, client);
    expect(client.calls).toBe(2);
    expect(manager.get()).toMatchObject({
      objective: "New objective",
      status: "active",
      turnsExecuted: 0,
    });
    expect(conversation.getMessages().at(-1)?.toolResults?.[0].isError).toBe(
      true,
    );
  });
  it.each([
    new RateLimitError("rate limited"),
    new ContextTooLongError("too long"),
  ])(
    "does not retry or compact a failed budget summary: $name",
    async (error) => {
      const manager = new GoalManager(cwd, "one");
      manager.set("Finish", 10);
      manager.beginTurn();
      manager.addTokens(14);
      manager.endRun();
      let calls = 0;
      const client: LLMClient = {
        setSystemPrompt: vi.fn(),
        async *stream() {
          calls++;
          yield await Promise.reject(error);
        },
      };
      const { events } = await run(manager, client);
      expect(calls).toBe(1);
      expect(events.at(-1)).toEqual({ type: "error", error });
      expect(manager.get()).toMatchObject({
        status: "budget_limited",
        budgetSummaryPending: false,
      });
    },
  );
  it("invalidates a cleared goal reminder before the next model request", async () => {
    const manager = new GoalManager(cwd, "one");
    manager.set("Old objective");
    const get = {
      type: "tool_call_complete",
      toolId: "get",
      toolName: "Goal",
      arguments: { action: "get" },
    } satisfies StreamEvent;
    const client = new Client([[get, end], [end]], () => {
      manager.clear();
    });
    await run(manager, client);
    expect(client.snapshots[1]).toContain("No persistent goal is set");
    expect(
      client.snapshots[1].lastIndexOf("No persistent goal is set"),
    ).toBeGreaterThan(client.snapshots[1].lastIndexOf("Goal: Old objective"));
  });
  it("counts blockers once per continuation turn and resumes a fresh blocked audit", async () => {
    const manager = new GoalManager(cwd, "one");
    manager.set("Finish");
    const blocked = {
      type: "tool_call_complete",
      toolId: "blocked",
      toolName: "Goal",
      arguments: {
        action: "update",
        status: "blocked",
        reason: "Service unavailable",
      },
    } satisfies StreamEvent;
    const client = new Client([
      [blocked, end],
      [end],
      [blocked, end],
      [end],
      [blocked, end],
      [end],
    ]);
    await run(manager, client);
    expect(manager.get()).toMatchObject({
      status: "blocked",
      blockedAttempts: 3,
      turnsExecuted: 3,
    });
    expect(handleGoalCommand(manager, "resume").prompt).toBeTruthy();
    manager.beginTurn();
    manager.update("blocked", "Service unavailable");
    manager.update("blocked", "Service unavailable");
    expect(manager.get()?.blockedAttempts).toBe(1);
  });
  it("resets a blocker streak when intervening turns make progress or report a different reason", () => {
    const manager = new GoalManager(cwd, "one");
    manager.set("Finish");
    manager.beginTurn();
    manager.update("blocked", "A");
    manager.beginTurn();
    manager.beginTurn();
    manager.update("blocked", "A");
    expect(manager.get()?.blockedAttempts).toBe(1);
    manager.beginTurn();
    manager.update("blocked", "B");
    expect(manager.get()?.blockedAttempts).toBe(1);
  });
  it("stops at the continuation limit and requires explicit continue", async () => {
    const manager = new GoalManager(cwd, "one");
    manager.set("Finish");
    for (let i = 1; i < MAX_GOAL_TURNS; i++) {
      manager.beginTurn();
    }
    const client = new Client([[end]]);
    await run(manager, client);
    expect(client.calls).toBe(1);
    expect(manager.get()?.status).toBe("max_turns");
    expect(handleGoalCommand(manager, "resume").message).toContain(
      "/goal continue",
    );
    expect(handleGoalCommand(manager, "continue").prompt).toBeTruthy();
    expect(manager.get()?.turnsExecuted).toBe(0);
  });
  it.each(["plan", "queue", "pause"])(
    "does not auto-continue while %s owns the next turn",
    async (gate) => {
      const manager = new GoalManager(cwd, "one");
      manager.set("Finish");
      const client = new Client([[end]], () => {
        if (gate === "pause") {
          manager.transition("paused");
        }
      });
      await run(manager, client, {
        mode: gate === "plan" ? "plan" : undefined,
        shouldContinue: () => gate !== "queue",
      });
      expect(client.calls).toBe(1);
    },
  );
  it("does not auto-restart an interrupted run or retry a provider error as goal progress", async () => {
    const manager = new GoalManager(cwd, "one");
    manager.set("Finish");
    const controller = new AbortController();
    const client = new Client([[end]], () => {
      controller.abort();
    });
    await run(manager, client, { signal: controller.signal });
    expect(client.calls).toBe(1);
    const failed: LLMClient = {
      setSystemPrompt: vi.fn(),
      async *stream() {
        await Promise.resolve();
        yield { type: "text_delta", text: "partial" };
        throw new Error("broken stream");
      },
    };
    const { events } = await run(manager, failed);
    expect(events.at(-1)?.type).toBe("error");
  });
  it("prevents delegated agents from completing or replacing the parent's goal", async () => {
    const registry = new ToolRegistry();
    registry.register(new GoalTool());
    expect(
      filterToolsForAgent(registry, undefined, undefined, false).get("Goal"),
    ).toBeUndefined();
    expect(
      filterToolsForAgent(registry, undefined, undefined, false).get("Goal"),
    ).toBeUndefined();
    expect(
      (
        await new GoalTool().execute(
          { cwd },
          { action: "update", status: "complete", reason: "done" },
        )
      ).isError,
    ).toBe(true);
  });
});
