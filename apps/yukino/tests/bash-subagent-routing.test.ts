import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentEvent } from "@/agent/events.js";
import { Agent } from "@/agent/index.js";
import type { ProviderConfig } from "@/config/provider-config.js";
import { ConversationManager } from "@/conversation/index.js";
import type { LLMClient } from "@/llm/client.js";
import type { StreamEvent, UsageInfo } from "@/llm/events.js";
import { PermissionChecker } from "@/permissions/index.js";
import { spawnSubagent } from "@/subagent/spawn.js";
import {
  formatAgentTaskNotification,
  TaskManager,
} from "@/subagent/task-manager.js";
import { BashTool } from "@/tools/bash.js";
import { ToolRegistry } from "@/tools/registry.js";
import type { Tool, ToolContext } from "@/tools/types.js";
import { contentToText } from "@/utils/index.js";

const USAGE: UsageInfo = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};
const end = (reason = "end_turn"): StreamEvent => ({
  type: "stream_end",
  stopReason: reason,
  usage: USAGE,
});

class MockClient implements LLMClient {
  calls = 0;
  constructor(private scripts: StreamEvent[][]) {}
  setSystemPrompt(_prompt: string): void {
    /** noop */
  }
  async *stream(): AsyncGenerator<StreamEvent> {
    const script = this.scripts[this.calls++] ?? [end()];
    for (const ev of script) {
      await Promise.resolve();
      yield ev;
    }
  }
  setMaxOutputTokens(_n: number): void {
    /** noop */
  }
}

function makeCwd(): string {
  return mkdtempSync(join(tmpdir(), "yukino-bash-route-"));
}

describe("background bash routing for subagent loops", () => {
  it("prefers ctx.taskManager over the host-wired instance default", async () => {
    const ctxManager = new TaskManager();
    const instanceManager = new TaskManager();
    const bash = new BashTool();
    bash.taskManager = instanceManager;

    const result = await bash.execute(
      { cwd: makeCwd(), taskManager: ctxManager },
      { command: "printf routed", run_in_background: true },
    );
    const match = /task_id: (bash-\d+)\)/.exec(result.output);
    expect(match).not.toBeNull();
    const taskId = match?.[1] ?? "";

    expect(ctxManager.get(taskId)).toBeDefined();
    expect(instanceManager.list()).toHaveLength(0);
    await ctxManager.get(taskId)?.done;
    expect(ctxManager.get(taskId)?.output).toContain("routed");
  });

  it("Agent injects its taskManager into every tool context", async () => {
    let seen: TaskManager | null | undefined;
    const probe: Tool = {
      name: "Probe",
      description: "probe",
      category: "read",
      schema: () => ({
        name: "Probe",
        description: "probe",
        input_schema: { type: "object", properties: {} },
      }),
      execute: (ctx: ToolContext) => {
        seen = ctx.taskManager;
        return Promise.resolve({ output: "ok", isError: false });
      },
    };

    const subManager = new TaskManager();
    const registry = new ToolRegistry();
    registry.register(probe);
    const conversation = new ConversationManager();
    conversation.addUserMessage("probe");
    const client = new MockClient([
      [
        {
          type: "tool_call_complete",
          toolId: "p1",
          toolName: "Probe",
          arguments: {},
        },
        end("tool_use"),
      ],
      [end()],
    ]);
    const agent = new Agent({
      client,
      registry,
      checker: new PermissionChecker(makeCwd(), "bypassPermissions"),
      conversation,
      cwd: makeCwd(),
      taskManager: subManager,
    });
    const events: AgentEvent[] = [];
    for await (const e of agent.run()) {
      events.push(e);
    }
    expect(events.some((e) => e.type === "loop_complete")).toBe(true);
    expect(seen).toBe(subManager);
  });

  it("drains a backgrounded Bash notification into the owning agent's own next turn", async () => {
    const subManager = new TaskManager();
    const bash = new BashTool();
    // No instance taskManager: only the ctx-resolved manager can enable
    // backgrounding, proving the routing path end to end.
    const registry = new ToolRegistry();
    registry.register(bash);

    const cwd = makeCwd();
    const conversation = new ConversationManager();
    conversation.addUserMessage("run it");

    const client = new MockClient([
      [
        {
          type: "tool_call_complete",
          toolId: "b1",
          toolName: "Bash",
          arguments: {
            command: "printf routed-agent",
            run_in_background: true,
          },
        },
        // Second call keeps the batch busy long enough for the backgrounded
        // printf to finish before the next turn's notification drain runs.
        {
          type: "tool_call_complete",
          toolId: "b2",
          toolName: "Bash",
          arguments: { command: "sleep 0.5" },
        },
        end("tool_use"),
      ],
      [end()],
    ]);

    const agent = new Agent({
      client,
      registry,
      checker: new PermissionChecker(cwd, "bypassPermissions"),
      conversation,
      cwd,
      taskManager: subManager,
      notificationFn: () =>
        subManager.drainNotifications().map(formatAgentTaskNotification),
    });

    const events: AgentEvent[] = [];
    for await (const e of agent.run()) {
      events.push(e);
    }

    // The backgrounded call returned a task ID immediately...
    const backgrounded = events.find(
      (e) => e.type === "tool_result" && e.toolId === "b1",
    );
    const taskId = subManager.list()[0]?.id;
    expect(
      backgrounded?.type === "tool_result" && backgrounded.output,
    ).toContain(`task_id: ${taskId}`);

    // ...and its completion reached this loop (not some other drain) as a
    // system reminder on the following turn.
    const allText = conversation
      .getMessages()
      .map((m) => contentToText(m.content))
      .join("\n");
    expect(allText).toContain(
      `<task-notification task_id="${taskId}" status="completed">`,
    );
    expect(allText).toContain("routed-agent");
    // Nothing left undrained for whoever might ask later.
    expect(subManager.drainNotifications()).toHaveLength(0);
  }, 15_000);

  it("spawnSubagent backgroundTasks:false disables backgrounding despite a host-wired manager", async () => {
    // In-process teammate turns are one spawnSubagent run per task turn: the
    // turn-end stopAll() would kill anything backgrounded and the drain
    // disappears before any notification could be delivered, so those runs
    // opt out — the explicit ctx.taskManager null must also block the tools'
    // fallback to the host-wired instance manager.
    const instanceManager = new TaskManager();
    const bash = new BashTool();
    bash.taskManager = instanceManager;

    let seen: TaskManager | null | undefined;
    const probe: Tool = {
      name: "Probe",
      description: "probe",
      category: "read",
      schema: () => ({
        name: "Probe",
        description: "probe",
        input_schema: { type: "object", properties: {} },
      }),
      execute: (ctx: ToolContext) => {
        seen = ctx.taskManager;
        return Promise.resolve({ output: "ok", isError: false });
      },
    };

    const registry = new ToolRegistry();
    registry.register(bash);
    registry.register(probe);

    const client = new MockClient([
      [
        {
          type: "tool_call_complete",
          toolId: "p1",
          toolName: "Probe",
          arguments: {},
        },
        {
          type: "tool_call_complete",
          toolId: "b1",
          toolName: "Bash",
          arguments: { command: "printf teammate-fg", run_in_background: true },
        },
        end("tool_use"),
      ],
      [end()],
    ]);

    await spawnSubagent(
      { name: "teammate", description: "foreground only" },
      "run it",
      client,
      registry,
      {
        name: "test",
        protocol: "openai",
        base_url: "http://127.0.0.1:1/v1",
        api_key: "test-only",
        model: "parent-model",
        thinking: "high",
      } satisfies ProviderConfig,
      makeCwd(),
      undefined,
      undefined,
      undefined,
      undefined,
      { backgroundTasks: false, permissionMode: "bypassPermissions" },
    );

    expect(seen).toBeNull();
    // The run_in_background request fell back to a foreground execution:
    // nothing registered anywhere.
    expect(instanceManager.list()).toHaveLength(0);
  }, 20_000);
});
