import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createToolRegistry } from "@/bootstrap/tool-registry.js";
import { buildToolGuidance } from "@/prompt/tools.js";
import {
  cloneRegistryForFork,
  filterToolsForAgent,
} from "@/subagent/tool-filter.js";
import { TeamManager } from "@/teams/index.js";
import { TaskList } from "@/todo/index.js";
import { TaskCreateTool, TaskUpdateTool, TodoWriteTool } from "@/todo/tools.js";
import type { ToolRegistry } from "@/tools/registry.js";

let cwd: string;
let manager: TeamManager;
const registries: ToolRegistry[] = [];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "yukino-tracking-mode-"));
  manager = new TeamManager(cwd);
});
afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.dispose()));
  await manager.dispose();
  rmSync(cwd, { recursive: true, force: true });
});

function registry(
  interactionMode: "interactive" | "non-interactive",
  list = new TaskList(),
) {
  const result = createToolRegistry(cwd, list, {
    interactionMode,
    teamManager: manager,
  });
  registries.push(result);
  return result;
}

function trackingNames(registry: ToolRegistry) {
  return registry
    .getAllSchemas()
    .map((schema) => schema.name)
    .filter((name) =>
      /^(TodoWrite|TaskCreate|TaskGet|TaskList|TaskUpdate)$/u.test(name),
    );
}

describe("tracking tool modes", () => {
  it.each(["interactive", "non-interactive"] as const)(
    "exposes only the %s tracking interface and scoped guidance",
    (mode) => {
      const tools = registry(mode);
      expect(trackingNames(tools)).toEqual(
        mode === "interactive"
          ? ["TaskCreate", "TaskGet", "TaskList", "TaskUpdate"]
          : ["TodoWrite"],
      );
      const prompt = buildToolGuidance(trackingNames(tools));
      expect(prompt).toContain("Completed items remain stored");
      if (mode === "interactive") {
        expect(prompt).not.toContain("TodoWrite");
      } else {
        expect(prompt).not.toContain("TaskCreate");
        expect(prompt).toContain("returned todos");
      }
      expect(tools.get("TaskOutput")).toBeDefined();
    },
  );

  it("switches a non-interactive leader to shared tasks for a team and restores its private TODOs on deletion", async () => {
    const list = new TaskList();
    const tools = registry("non-interactive", list);
    await tools
      .get("TodoWrite")
      ?.execute(
        { cwd },
        { todos: [{ subject: "private", status: "completed" }] },
      );
    manager.create("squad");
    expect(trackingNames(tools)).toEqual([
      "TaskCreate",
      "TaskGet",
      "TaskList",
      "TaskUpdate",
    ]);
    await tools
      .get("TaskCreate")
      ?.execute({ cwd }, { subject: "shared", description: "" });
    expect(list.list()[0]?.subject).toBe("private");
    expect(manager.getTaskStore("squad").listTasks()[0]?.subject).toBe(
      "shared",
    );
    await manager.delete("squad");
    expect(trackingNames(tools)).toEqual(["TodoWrite"]);
    const next = await tools.get("TodoWrite")?.execute(
      { cwd },
      {
        todos: [
          { id: "1", subject: "private", status: "completed" },
          { subject: "next", status: "pending" },
        ],
      },
    );
    expect(next?.output).toContain("TODO 1/2");
    expect(list.list().map((task) => task.id)).toEqual(["1", "2"]);
  });

  it.each(["fork", "foreground", "background"])(
    "inherits the TODO interface with isolated %s lists",
    async (kind) => {
      const list = new TaskList();
      list.create("parent", "");
      const parent = registry("non-interactive", list);
      const clone = () =>
        kind === "fork"
          ? cloneRegistryForFork(parent)
          : filterToolsForAgent(
              parent,
              undefined,
              undefined,
              kind === "background",
            );
      const child = clone();
      const sibling = clone();
      registries.push(child, sibling);
      expect(trackingNames(child)).toEqual(["TodoWrite"]);
      await child
        .get("TodoWrite")
        ?.execute(
          { cwd },
          { todos: [{ subject: "child", status: "completed" }] },
        );
      await sibling
        .get("TodoWrite")
        ?.execute(
          { cwd },
          { todos: [{ subject: "sibling", status: "pending" }] },
        );
      const childResult = await child
        .get("TodoWrite")
        ?.execute(
          { cwd },
          { todos: [{ id: "1", subject: "child", status: "completed" }] },
        );
      expect(childResult?.isError).toBe(false);
      expect(childResult?.output).toContain("TODO 1/1");
      expect(childResult?.output).not.toContain("sibling");
      expect(list.list()[0]?.subject).toBe("parent");
    },
  );

  it("gives Task and TODO operations the same snapshots, completion counts and atomic failure behavior", async () => {
    const tasks = new TaskList();
    const todos = new TaskList();
    const create = new TaskCreateTool(tasks);
    const update = new TaskUpdateTool(tasks);
    const write = new TodoWriteTool(todos);
    await create.execute(
      { cwd },
      { subject: "first", description: "", activeForm: "Working" },
    );
    await create.execute({ cwd }, { subject: "second", description: "" });
    await update.execute({ cwd }, { taskId: "1", status: "completed" });
    await update.execute(
      { cwd },
      { taskId: "2", status: "blocked", priority: "high" },
    );
    const written = await write.execute(
      { cwd },
      {
        todos: [
          { subject: "first", status: "completed", activeForm: "Working" },
          { subject: "second", status: "blocked", priority: "high" },
        ],
      },
    );
    expect(todos.list()).toEqual(tasks.list());
    const serializedTasks: unknown = JSON.parse(JSON.stringify(tasks.list()));
    expect(JSON.parse(written.output)).toEqual({
      todos: serializedTasks,
      progress: "TODO 1/2",
    });
    const completed = await update.execute(
      { cwd },
      { taskId: "2", status: "completed" },
    );
    expect(completed.output).toContain("TODO 2/2");
    await write.execute(
      { cwd },
      {
        todos: [
          { id: "1", subject: "first", status: "completed" },
          { id: "2", subject: "second", status: "completed" },
        ],
      },
    );
    expect(todos.list()).toEqual(tasks.list());
    for (const tool of [write, update]) {
      const result = await tool.execute(
        { cwd },
        tool === write
          ? { todos: [{ id: "unknown", subject: "bad", status: "pending" }] }
          : { taskId: "2", status: "bad" },
      );
      expect(result.isError).toBe(true);
    }
    expect(todos.list()).toEqual(tasks.list());
  });
});
