import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import z from "zod";

import { createToolRegistry } from "@/bootstrap/tool-registry.js";
import { buildToolGuidance } from "@/prompt/tools.js";
import { sessionPath } from "@/storage/index.js";
import { filterToolsForAgent } from "@/subagent/tool-filter.js";
import { TeamManager } from "@/teams/index.js";
import { SharedTaskStore } from "@/teams/shared-task.js";
import { teamDir } from "@/teams/team-file.js";
import { TaskList } from "@/todo/index.js";
import { StoredTaskSchema, TaskStore } from "@/todo/store.js";
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
  it.each(["private", "shared"])(
    "round-trips metadata through TaskCreate, TaskUpdate, TaskGet and the %s task file",
    async (board) => {
      const list = new TaskList(new TaskStore("metadata"));
      const tools = registry("interactive", list);
      if (board === "shared") {
        manager.create("squad");
      }
      const create = tools.get("TaskCreate");
      const update = tools.get("TaskUpdate");
      const get = tools.get("TaskGet");
      if (!create || !update || !get) {
        throw new Error("Missing task tools");
      }
      for (const tool of [create, update]) {
        expect(tool.schema().input_schema.properties.metadata).toMatchObject({
          type: "object",
          additionalProperties: {},
        });
      }
      expect(
        (
          await create.execute(
            { cwd },
            {
              subject: "keep structured context",
              description: "",
              metadata: {
                ticket: "issue-20",
                labels: ["bug"],
                evidence: { reviewed: false },
                obsolete: "remove",
              },
            },
          )
        ).isError,
      ).toBe(false);
      const created = await get.execute({ cwd }, { taskId: "1" });
      expect(created.isError).toBe(false);
      expect(
        StoredTaskSchema.parse(JSON.parse(created.output)).metadata,
      ).toEqual({
        ticket: "issue-20",
        labels: ["bug"],
        evidence: { reviewed: false },
        obsolete: "remove",
      });
      expect(
        (
          await update.execute(
            { cwd },
            {
              taskId: "1",
              metadata: {
                ticket: "issue-21",
                evidence: { checked: true },
                obsolete: null,
                added: [null, 2],
              },
            },
          )
        ).isError,
      ).toBe(false);
      expect(
        (
          await update.execute(
            { cwd },
            { taskId: "1", description: "updated without metadata" },
          )
        ).isError,
      ).toBe(false);
      const expected = {
        ticket: "issue-21",
        labels: ["bug"],
        evidence: { checked: true },
        added: [null, 2],
      };
      const updated = await get.execute({ cwd }, { taskId: "1" });
      expect(updated.isError).toBe(false);
      expect(
        StoredTaskSchema.parse(JSON.parse(updated.output)).metadata,
      ).toEqual(expected);
      const restored =
        board === "shared"
          ? new SharedTaskStore(join(teamDir(cwd, "squad"), "tasks.json")).get(
              "1",
            )
          : new TaskList(new TaskStore("metadata")).get("1");
      expect(restored?.metadata).toEqual(expected);
      const taskFile =
        board === "shared"
          ? join(teamDir(cwd, "squad"), "tasks.json")
          : sessionPath("metadata", "tasks.json");
      expect(JSON.parse(readFileSync(taskFile, "utf8"))).toEqual({
        nextId: 2,
        tasks: [expect.objectContaining({ id: "1", metadata: expected })],
      });
    },
  );

  it.each(["private", "shared"])(
    "rejects malformed task and dependency IDs consistently on the %s board",
    async (board) => {
      const list = new TaskList();
      const tools = registry("interactive", list);
      if (board === "shared") {
        manager.create("squad");
      }
      const create = tools.get("TaskCreate");
      const get = tools.get("TaskGet");
      const update = tools.get("TaskUpdate");
      if (!create || !get || !update) {
        throw new Error("Missing task tools");
      }
      await create.execute({ cwd }, { subject: "original", description: "" });
      for (const tool of [get, update]) {
        expect(tool.schema().input_schema.properties.taskId).toMatchObject({
          type: "string",
          pattern: "^[1-9]\\d*$",
        });
        for (const taskId of [
          undefined,
          1,
          "",
          "0",
          "01",
          "-1",
          "1.0",
          " 1 ",
          "1\n",
          "task-1",
        ]) {
          const result = await tool.execute({ cwd }, { taskId });
          expect(result.isError).toBe(true);
          expect(result.output).toContain("taskId");
        }
      }
      for (const field of ["addBlocks", "addBlockedBy"]) {
        for (const id of [1, "0", "01", "-1", "1.0", " 1 ", "task-1"]) {
          const result = await update.execute(
            { cwd },
            { taskId: "1", subject: "must not change", [field]: [id] },
          );
          expect(result.isError).toBe(true);
          expect(result.output).toContain(field);
        }
      }
      const task = await get.execute({ cwd }, { taskId: "1" });
      expect(task.isError).toBe(false);
      expect(JSON.parse(task.output)).toMatchObject({
        subject: "original",
        blocks: [],
        blockedBy: [],
      });
      const missing = await get.execute({ cwd }, { taskId: "999" });
      expect(missing).toMatchObject({
        isError: true,
        output: "Task not found",
      });
    },
  );

  it.each(["private", "shared"])(
    "rejects unsupported Task fields on the %s board without mutating tasks",
    async (board) => {
      const list = new TaskList();
      const tools = registry("interactive", list);
      if (board === "shared") {
        manager.create("squad");
      }
      const tasks = () =>
        board === "shared"
          ? manager.getTaskStore("squad").listTasks()
          : list.list();
      const create = tools.get("TaskCreate");
      const update = tools.get("TaskUpdate");
      if (!create || !update) {
        throw new Error("Missing task tools");
      }
      expect(Object.keys(create.schema().input_schema.properties)).toEqual([
        "subject",
        "description",
        "metadata",
      ]);
      expect(Object.keys(update.schema().input_schema.properties)).toEqual([
        "taskId",
        "status",
        "subject",
        "description",
        "owner",
        "priority",
        "metadata",
        "addBlocks",
        "addBlockedBy",
      ]);
      for (const fields of [
        { unknownField: "unsupported" },
        { metadata: null },
        { metadata: [] },
        { metadata: "invalid" },
        { metadata: 42 },
      ]) {
        const result = await create.execute(
          { cwd },
          { subject: "removed", description: "", ...fields },
        );
        expect(result.isError).toBe(true);
        expect(tasks()).toEqual([]);
      }
      expect(
        (await create.execute({ cwd }, { subject: "work", description: "" }))
          .isError,
      ).toBe(false);
      const before = tasks();
      expect(before[0]?.id).toBe("1");
      for (const fields of [
        { unknownField: "unsupported" },
        { metadata: null },
        { metadata: [] },
        { metadata: "invalid" },
        { metadata: 42 },
      ]) {
        const result = await update.execute(
          { cwd },
          { taskId: "1", status: "completed", ...fields },
        );
        expect(result.isError).toBe(true);
        expect(tasks()).toEqual(before);
      }
    },
  );

  it("exposes only supported TODO fields and rejects unknown fields atomically", async () => {
    const list = new TaskList();
    list.create("existing", "");
    const tool = new TodoWriteTool(list);
    const schema = z
      .object({
        items: z.object({ properties: z.record(z.string(), z.unknown()) }),
      })
      .parse(tool.schema().input_schema.properties.todos);
    expect(Object.keys(schema.items.properties)).toEqual([
      "id",
      "subject",
      "description",
      "status",
      "priority",
    ]);
    const before = list.list();
    const result = await tool.execute(
      { cwd },
      {
        todos: [
          {
            subject: "invalid",
            status: "pending",
            unknownField: "unsupported",
          },
        ],
      },
    );
    expect(result.isError).toBe(true);
    expect(list.list()).toEqual(before);
  });

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
          ? filterToolsForAgent(parent, undefined, undefined, false)
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
    await create.execute({ cwd }, { subject: "first", description: "" });
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
          { subject: "first", status: "completed" },
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
