import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { render, type Instance } from "ink";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createToolRegistry } from "@/bootstrap/tool-registry.js";
import { TeamManager } from "@/teams/index.js";
import { SharedTaskStore } from "@/teams/shared-task.js";
import { teamDir } from "@/teams/team-file.js";
import { TaskList } from "@/todo/index.js";
import type { ToolRegistry } from "@/tools/registry.js";
import { TodoProgress } from "@/ui/todo-progress.js";
import { useTaskProgress } from "@/ui/use-task-progress.js";

let cwd: string;
let manager: TeamManager;
let list: TaskList;
let registry: ToolRegistry;
let instance: Instance | undefined;
let frame: string;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  cwd = mkdtempSync(join(tmpdir(), "yukino-ui-tracking-"));
  manager = new TeamManager(cwd);
  list = new TaskList();
  frame = "";
  vi.spyOn(process.stdout, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      frame = stripVTControlCharacters(String(chunk));
      return true;
    },
  );
});

afterEach(async () => {
  act(() => {
    instance?.unmount();
    instance?.cleanup();
  });
  instance = undefined;
  await registry.dispose();
  await manager.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(cwd, { recursive: true, force: true });
});

function Progress() {
  const { tasks, boardId } = useTaskProgress(list, manager);
  return <TodoProgress key={boardId} tasks={tasks} />;
}

function mount(
  interactionMode: "interactive" | "non-interactive" = "interactive",
) {
  registry = createToolRegistry(cwd, list, {
    interactionMode,
    teamManager: manager,
  });
  act(() => {
    instance = render(<Progress />, {
      patchConsole: false,
      interactive: false,
      debug: true,
    });
  });
}

async function execute(name: string, args: Record<string, unknown>) {
  const tool = registry.get(name);
  if (!tool) {
    throw new Error(`Missing tool ${name}`);
  }
  let output = "";
  await act(async () => {
    const result = await tool.execute({ cwd }, args);
    expect(result.isError).toBe(false);
    output = result.output;
  });
  return output;
}

function advance(milliseconds: number) {
  act(() => {
    vi.advanceTimersByTime(milliseconds);
  });
}

describe("tool and UI TODO synchronization", () => {
  it("renders Task mutations immediately and hides completed progress without deleting tasks", async () => {
    mount();
    expect(
      await execute("TaskCreate", { subject: "work", description: "" }),
    ).toContain("TODO 0/1");
    expect(frame).toContain("TODO 0/1");
    expect(
      await execute("TaskUpdate", { taskId: "1", status: "completed" }),
    ).toContain("TODO 1/1");
    expect(frame).toContain("TODO 1/1");
    advance(5000);
    expect(frame).toBe("");
    expect(list.list()).toHaveLength(1);
    await execute("TaskUpdate", { taskId: "1", status: "in_progress" });
    expect(frame).toContain("TODO 0/1");
    await execute("TaskUpdate", { taskId: "1", status: "deleted" });
    expect(frame).toBe("");
  });

  it("renders TodoWrite replacements with the same count rules and retains completed items", async () => {
    mount("non-interactive");
    const result = await execute("TodoWrite", {
      todos: [
        { subject: "done", status: "completed" },
        { subject: "cancelled", status: "cancelled" },
        { subject: "blocked", status: "blocked" },
      ],
    });
    expect(JSON.parse(result)).toMatchObject({ progress: "TODO 1/3" });
    expect(frame).toContain("TODO 1/3");
    advance(6000);
    expect(frame).toContain("TODO 1/3");
    await execute("TodoWrite", {
      todos: [{ id: "1", subject: "done", status: "completed" }],
    });
    expect(frame).toContain("TODO 1/1");
    advance(5000);
    expect(frame).toBe("");
    expect(list.list()[0]?.status).toBe("completed");
    await execute("TodoWrite", { todos: [] });
    expect(list.list()).toEqual([]);
    expect(frame).toBe("");
  });

  it("follows shared boards, observes external writes, and resets hiding across matching task IDs", async () => {
    mount();
    await execute("TaskCreate", { subject: "private", description: "" });
    await execute("TaskUpdate", { taskId: "1", status: "completed" });
    advance(5000);
    expect(frame).toBe("");
    act(() => {
      manager.create("squad");
    });
    await execute("TaskCreate", { subject: "shared", description: "" });
    expect(frame).toContain("TODO 0/1");
    await execute("TaskUpdate", { taskId: "1", status: "completed" });
    expect(frame).toContain("TODO 1/1");
    advance(5000);
    expect(frame).toBe("");
    const external = new SharedTaskStore(
      join(teamDir(cwd, "squad"), "tasks.json"),
    );
    external.create("teammate work");
    advance(500);
    expect(frame).toContain("TODO 1/2");
    act(() => {
      manager.getTaskStore("squad").update("2", { status: "completed" });
    });
    expect(frame).toContain("TODO 2/2");
    await act(async () => {
      await manager.delete("squad");
    });
    expect(frame).toContain("TODO 1/1");
    expect(list.list()[0]?.subject).toBe("private");
    advance(4999);
    expect(frame).toContain("TODO 1/1");
    advance(1);
    expect(frame).toBe("");
    act(() => {
      manager.create("squad");
    });
    await execute("TaskCreate", { subject: "new shared", description: "" });
    await execute("TaskUpdate", { taskId: "1", status: "completed" });
    expect(frame).toContain("TODO 1/1");
  });
});
