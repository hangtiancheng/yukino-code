import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "@/agent/events.js";
import { Agent } from "@/agent/index.js";
import { ConversationManager } from "@/conversation/index.js";
import {
  GoalManager,
  handleGoalCommand,
  MAX_GOAL_TURNS,
} from "@/goal/index.js";
import type { LLMClient } from "@/llm/client.js";
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
import {
  cloneRegistryForFork,
  filterToolsForAgent,
} from "@/subagent/tool-filter.js";
import { GoalTool } from "@/tools/goal.js";
import { ToolRegistry } from "@/tools/registry.js";

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
  constructor(
    private scripts: StreamEvent[][],
    private callback?: () => void,
  ) {}
  setSystemPrompt = vi.fn();
  async *stream(
    conversation: ConversationManager,
  ): AsyncGenerator<StreamEvent> {
    this.snapshots.push(JSON.stringify(conversation.getMessages()));
    const script = this.scripts[this.calls++] ?? [end];
    this.callback?.();
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
  });
  const events: AgentEvent[] = [];
  for await (const event of agent.run()) {
    events.push(event);
  }
  return { events, conversation };
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
  it("accounts for cache tokens and stops pending tools at the token budget", async () => {
    const manager = new GoalManager(cwd, "one");
    manager.set("Finish", 10);
    const client = new Client([[complete, end]]);
    const { events, conversation } = await run(manager, client);
    expect(client.calls).toBe(1);
    expect(manager.get()).toMatchObject({
      status: "budget_limited",
      tokensUsed: 14,
    });
    expect(conversation.getMessages().at(-1)?.toolResults?.[0].isError).toBe(
      true,
    );
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
    expect(cloneRegistryForFork(registry).get("Goal")).toBeUndefined();
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
