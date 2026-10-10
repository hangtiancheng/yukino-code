import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { Agent } from "@/agent/index.js";
import { ConversationManager } from "@/conversation/index.js";
import type { LLMClient } from "@/llm/client.js";
import type { StreamEvent } from "@/llm/events.js";
import { PermissionChecker } from "@/permissions/index.js";
import {
  loadSession,
  loadTranscript,
  rebuildFromSession,
  saveMessage,
} from "@/session/index.js";
import { sessionPath } from "@/storage/paths.js";
import { AgentTool } from "@/subagent/agent-tool.js";
import { spawnSubagent } from "@/subagent/spawn.js";
import {
  formatAgentTaskNotification,
  TaskManager,
} from "@/subagent/task-manager.js";
import { ToolRegistry } from "@/tools/registry.js";
import { TaskOutputTool } from "@/tools/task-output.js";
import { contentToText } from "@/utils/index.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "yukino-bg-recovery-"));
  directories.push(path);
  return path;
}

function end(reason = "end_turn"): StreamEvent {
  return {
    type: "stream_end",
    stopReason: reason,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  };
}

function client(scripts: StreamEvent[][]): LLMClient {
  let calls = 0;
  return {
    setSystemPrompt: () => undefined,
    async *stream() {
      await Promise.resolve();
      for (const event of scripts[calls++] ?? [end()]) {
        yield event;
      }
    },
  };
}

const provider = {
  name: "test",
  protocol: "openai" as const,
  model: "test",
  base_url: "http://127.0.0.1:1",
};
const noop = () => undefined;

describe("background agent durable recovery", () => {
  it.each(["completed", "failed"] as const)(
    "replays a %s task notification exactly once and in delivery order",
    async (status) => {
      const cwd = directory();
      const tasks = new TaskManager("leader");
      const task = tasks.create(
        "dispatch description",
        () =>
          status === "completed"
            ? Promise.resolve("background report")
            : Promise.reject(new Error("background failure")),
        noop,
      );
      await task.done;
      const notification = formatAgentTaskNotification(task);
      const conversation = new ConversationManager();
      conversation.addUserMessage("request");
      saveMessage(cwd, "leader", {
        role: "user",
        content: "request",
        timestamp: 1,
      });
      const registry = new ToolRegistry();
      const agent = new Agent({
        client: client([[{ type: "text_delta", text: "answer" }, end()]]),
        registry,
        checker: new PermissionChecker(cwd, "bypassPermissions"),
        conversation,
        cwd,
        sessionId: "leader",
        notificationFn: () =>
          tasks.drainNotifications().map(formatAgentTaskNotification),
      });
      for await (const event of agent.run()) {
        expect(event.type).not.toBe("error");
      }
      const replay = rebuildFromSession(loadSession(cwd, "leader"));
      expect(replay.map((message) => contentToText(message.content))).toEqual([
        "request",
        `<system-reminder>\n${notification}\n</system-reminder>`,
        "answer",
      ]);
      const restored = new TaskManager("leader");
      expect(restored.drainNotifications()).toEqual([]);
      expect(restored.get(task.id)).toMatchObject({
        id: task.id,
        name: task.name,
        status,
        output: task.output,
      });
      await registry.dispose();
    },
  );

  it("restores unconsumed outcomes, isolates sessions, and never reuses restored task IDs", async () => {
    const tasks = new TaskManager("leader");
    const task = tasks.create("worker", () => Promise.resolve("report"), noop);
    await task.done;
    vi.resetModules();
    const { TaskManager: RestoredTaskManager } =
      await import("@/subagent/task-manager.js");
    const restored = new RestoredTaskManager("leader");
    expect(restored.hasNotifications()).toBe(true);
    expect(restored.drainNotifications().map((item) => item.id)).toEqual([
      task.id,
    ]);
    const next = restored.create(
      "next",
      () => Promise.resolve("next report"),
      noop,
    );
    expect(Number(next.id.split("-").at(-1))).toBeGreaterThan(
      Number(task.id.split("-").at(-1)),
    );
    await next.done;
    expect(new TaskManager("another-session").get(task.id)).toBeUndefined();
  });

  it("marks abandoned running tasks failed instead of restoring phantom workers", async () => {
    const tasks = new TaskManager("leader");
    let finish!: (output: string) => void;
    const task = tasks.create(
      "lost worker",
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
      noop,
    );
    await Promise.resolve();
    try {
      const restored = new TaskManager("leader");
      expect(restored.get(task.id)).toMatchObject({ status: "failed" });
      expect(restored.get(task.id)?.output).toContain("interrupted");
      expect(restored.hasRunning()).toBe(false);
      expect(restored.hasNotifications()).toBe(true);
    } finally {
      finish("cleanup");
      await task.done;
    }
  });

  it("keeps archived failed tasks queryable beyond the in-memory retention cap", async () => {
    const tasks = new TaskManager("leader");
    const failed = tasks.create(
      "first failed",
      () => Promise.reject(new Error("original failure")),
      noop,
    );
    for (let index = 0; index < 200; index++) {
      tasks.create(
        `worker ${String(index)}`,
        () => Promise.resolve("ok"),
        noop,
      );
    }
    await tasks.waitAll();
    tasks.drainNotifications();
    expect(tasks.list()).toHaveLength(200);
    const result = await new TaskOutputTool(tasks).execute(
      { cwd: directory() },
      { task_id: failed.id },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "failed",
      output: "Error: original failure",
    });
    expect(new TaskManager("leader").get(failed.id)?.output).toContain(
      "original failure",
    );
  });

  it("persists a child's prompt and complete tool chain without adding it to the leader history", async () => {
    const cwd = directory();
    const registry = new ToolRegistry();
    registry.register({
      name: "ReadFile",
      description: "read",
      category: "read",
      schema: () => ({
        name: "ReadFile",
        description: "read",
        input_schema: { type: "object", properties: {} },
      }),
      execute: () =>
        Promise.resolve({ output: "verified assertion", isError: false }),
    });
    const output = await spawnSubagent(
      { name: "worker", description: "worker" },
      "verify assertion",
      client([
        [
          { type: "text_delta", text: "checking" },
          {
            type: "tool_call_complete",
            toolId: "read",
            toolName: "ReadFile",
            arguments: {},
          },
          end("tool_use"),
        ],
        [{ type: "text_delta", text: "verified report" }, end()],
      ]),
      registry,
      provider,
      cwd,
      undefined,
      undefined,
      undefined,
      new PermissionChecker(cwd, "bypassPermissions"),
      { sessionId: "child" },
    );
    expect(output).toContain("verified report");
    const path = sessionPath("child", "transcript.jsonl");
    expect(existsSync(path)).toBe(true);
    const replay = rebuildFromSession(loadTranscript(path));
    expect(
      replay.some((message) => message.content === "verify assertion"),
    ).toBe(true);
    expect(
      replay.some((message) => message.toolUses?.[0]?.toolUseId === "read"),
    ).toBe(true);
    expect(
      replay.some(
        (message) => message.toolResults?.[0]?.content === "verified assertion",
      ),
    ).toBe(true);
    expect(loadSession(cwd, "leader")).toEqual([]);
    await registry.dispose();
  });

  it("retains partial output and the transcript when a background agent reaches its iteration cap", async () => {
    const cwd = directory();
    const registry = new ToolRegistry();
    registry.register({
      name: "ReadFile",
      description: "read",
      category: "read",
      schema: () => ({
        name: "ReadFile",
        description: "read",
        input_schema: { type: "object", properties: {} },
      }),
      execute: () => Promise.resolve({ output: "read result", isError: false }),
    });
    const tasks = new TaskManager("leader");
    const checker = new PermissionChecker(cwd, "bypassPermissions");
    const tool = new AgentTool(
      cwd,
      registry,
      (definition, prompt, background, _model, _cwd, context) =>
        spawnSubagent(
          { ...definition, maxTurns: 1 },
          prompt,
          client([
            [
              { type: "text_delta", text: "partial verified progress" },
              {
                type: "tool_call_complete",
                toolId: "read",
                toolName: "ReadFile",
                arguments: {},
              },
              end("tool_use"),
            ],
          ]),
          registry,
          provider,
          cwd,
          undefined,
          undefined,
          undefined,
          checker,
          { background, sessionId: context?.subagentSessionId },
        ),
      undefined,
      undefined,
      tasks,
    );
    await tool.execute(
      { cwd, sessionId: "leader" },
      {
        description: "original assignment",
        prompt: "work",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
    );
    const task = tasks.list()[0];
    await task.done;
    const result = await new TaskOutputTool(tasks).execute(
      { cwd },
      { task_id: task.id },
    );
    expect(result.isError).toBe(false);
    expect(task.status).toBe("failed");
    expect(task.output).toContain("maximum iterations (1)");
    expect(task.output).toContain("partial verified progress");
    const report = z
      .object({ transcript_path: z.string() })
      .parse(JSON.parse(result.output));
    expect(existsSync(report.transcript_path)).toBe(true);
    expect(readFileSync(report.transcript_path, "utf8")).toContain(
      "partial verified progress",
    );
    expect(formatAgentTaskNotification(task)).toContain(
      `task_id="${task.id}" status="failed"`,
    );
    expect(formatAgentTaskNotification(task)).toContain(
      "name=original assignment",
    );
    expect(new TaskManager("leader").get(task.id)?.output).toBe(task.output);
    await registry.dispose();
  });
});
