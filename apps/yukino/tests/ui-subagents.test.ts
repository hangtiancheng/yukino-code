import type { AgentEventSink } from "@yukino.js/subagent/spawn.js";
import {
  TaskManager,
  type AgentTask,
} from "@yukino.js/subagent/task-manager.js";
import { TaskOutputTool } from "@yukino.js/tools/task-output.js";
import { useSubagents } from "@yukino.js/ui/use-subagents.js";
import { render, type Instance } from "ink";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let instance: Instance | undefined;
let tasks: TaskManager;
let current: ReturnType<typeof useSubagents> | undefined;

function Harness() {
  current = useSubagents(tasks);
  return null;
}

function state() {
  if (!current) {
    throw new Error("Subagent harness is not mounted");
  }
  return current;
}

beforeEach(() => {
  tasks = new TaskManager();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  act(() => {
    instance = render(createElement(Harness), {
      patchConsole: false,
      interactive: false,
    });
  });
});

afterEach(() => {
  act(() => {
    instance?.unmount();
    instance?.cleanup();
  });
  instance = undefined;
  current = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("subagent progress lifecycle", () => {
  it.each(["completed", "failed"] as const)(
    "unloads %s background progress while retaining its result",
    async (status) => {
      let task!: AgentTask;
      let finish!: () => void;
      const pending = new Promise<string>((resolve, reject) => {
        finish = () => {
          if (status === "failed") {
            reject(new Error("run failed"));
          } else {
            resolve("verified result");
          }
        };
      });
      await act(async () => {
        task = tasks.create(
          "worker",
          (background) =>
            state().track(
              {
                toolCallId: "background",
                taskId: background.id,
                role: "explore",
              },
              () => pending,
            ),
          () => undefined,
        );
        await Promise.resolve();
      });
      expect(state().subagents).toHaveLength(1);
      await act(async () => {
        finish();
        await task.done;
      });
      expect(state().subagents).toEqual([]);
      expect(state().cardsRef.current.size).toBe(0);
      const result = await new TaskOutputTool(tasks).execute(
        { cwd: process.cwd() },
        { task_id: task.id },
      );
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.output)).toMatchObject({
        status,
        output: status === "failed" ? "Error: run failed" : "verified result",
      });
      expect(tasks.drainNotifications()).toEqual([task]);
      expect(tasks.drainNotifications()).toEqual([]);
    },
  );

  it("keeps running background progress across parent turns and preserves foreground card outcomes", async () => {
    let task!: AgentTask;
    let send!: AgentEventSink;
    let finish!: (output: string) => void;
    const pending = new Promise<string>((resolve) => {
      finish = resolve;
    });
    await act(async () => {
      await state().track({ toolCallId: "foreground", role: "explore" }, () =>
        Promise.resolve("foreground report"),
      );
      task = tasks.create(
        "worker",
        (background) =>
          state().track(
            {
              toolCallId: "background",
              taskId: background.id,
              role: "explore",
            },
            (onEvent) => {
              send = onEvent;
              return pending;
            },
          ),
        () => undefined,
      );
    });
    expect(state().cardsRef.current.get("foreground")).toMatchObject({
      status: "completed",
    });
    act(() => {
      send({ type: "turn_complete" });
      state().prepareTurn();
      send({
        type: "tool_use",
        toolId: "read",
        toolName: "ReadFile",
        args: {},
      });
    });
    expect(state().subagents).toEqual([
      expect.objectContaining({
        taskId: task.id,
        status: "running",
        turnCount: 1,
        lastTool: "ReadFile",
      }),
    ]);
    expect(state().cardsRef.current.size).toBe(0);
    await act(async () => {
      finish("done");
      await task.done;
    });
    expect(state().subagents).toEqual([]);
  });

  it("unloads cancelled progress immediately and ignores late events during cleanup", async () => {
    let task!: AgentTask;
    let send!: AgentEventSink;
    let finish!: (output: string) => void;
    const controller = new AbortController();
    const pending = new Promise<string>((resolve) => {
      finish = resolve;
    });
    await act(async () => {
      task = tasks.create(
        "worker",
        (background) =>
          state().track(
            {
              toolCallId: "background",
              taskId: background.id,
              role: "explore",
              abortSignal: controller.signal,
            },
            (onEvent) => {
              send = onEvent;
              return pending;
            },
          ),
        () => {
          controller.abort();
        },
      );
      await Promise.resolve();
    });
    act(() => {
      tasks.stop(task.id);
    });
    expect(controller.signal.aborted).toBe(true);
    expect(state().subagents).toEqual([]);
    expect(tasks.hasNotifications()).toBe(false);
    act(() => {
      send({ type: "tool_use", toolId: "late", toolName: "Bash", args: {} });
      send({ type: "turn_complete" });
      state().prepareTurn();
    });
    expect(state().subagents).toEqual([]);
    await act(async () => {
      finish("late result");
      await task.done;
    });
    expect(state().subagents).toEqual([]);
    expect(state().cardsRef.current.size).toBe(0);
    expect(task).toMatchObject({
      status: "cancelled",
      output: "Stopped by user",
    });
    expect(tasks.drainNotifications()).toEqual([task]);
    expect(tasks.drainNotifications()).toEqual([]);
  });
});
