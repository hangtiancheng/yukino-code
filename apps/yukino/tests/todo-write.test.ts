import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { TeamManager } from "@yukino.js/teams";
import { SharedTaskStore } from "@yukino.js/teams/shared-task.js";
import { TeamTodoWriteTool } from "@yukino.js/teams/task-tools.js";
import { TaskList } from "@yukino.js/todo";
import { TaskStore } from "@yukino.js/todo/store.js";
import { TodoWriteTool } from "@yukino.js/todo/tools.js";

const directories: string[] = [];
function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), "yukino-todo-write-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function board(kind: string) {
  return kind === "shared"
    ? new SharedTaskStore(join(temporaryDirectory(), "tasks.json"))
    : new TaskList(new TaskStore("atomic"));
}

describe("incremental TODO transactions", () => {
  it.each(["private", "shared"])(
    "retains other tasks and fields across independent %s edits",
    (kind) => {
      const tasks = board(kind);
      tasks.write({
        todos: [{ subject: "first", priority: "low" }, { subject: "second" }],
      });
      tasks.write({ todos: [{ id: "1", status: "completed" }] });
      tasks.write({ todos: [{ id: "2", status: "completed" }] });
      tasks.write({ todos: [{ id: "1", priority: "high" }] });
      expect(tasks.write({})).toMatchObject([
        { id: "1", status: "completed", priority: "high" },
        { id: "2", status: "completed" },
      ]);
    },
  );

  it("merges stale shared instances into the current board", () => {
    const path = join(temporaryDirectory(), "tasks.json");
    const first = new SharedTaskStore(path);
    first.write({ todos: [{ subject: "first" }, { subject: "second" }] });
    const second = new SharedTaskStore(path);
    first.write({ todos: [{ id: "1", status: "completed" }] });
    second.write({
      todos: [
        { id: "2", status: "completed" },
        { id: "1", priority: "high" },
      ],
    });
    expect(first.write({})).toMatchObject([
      { id: "1", status: "completed", priority: "high" },
      { id: "2", status: "completed" },
    ]);
  });

  it.each(["private", "shared"])(
    "validates %s dependency edits against the final batch and removes reciprocal links",
    (kind) => {
      const tasks = board(kind);
      tasks.write({
        todos: [
          { subject: "first" },
          { subject: "second" },
          { subject: "third" },
        ],
      });
      const edits = tasks.write({
        todos: [
          { id: "2", blockedBy: ["1"], status: "in_progress" },
          { id: "1", status: "completed" },
          { id: "3", blockedBy: ["2", "2"] },
        ],
      });
      expect(edits).toMatchObject([
        { id: "1", blocks: ["2"], status: "completed" },
        { id: "2", blocks: ["3"], blockedBy: ["1"], status: "in_progress" },
        { id: "3", blockedBy: ["2"] },
      ]);
      tasks.write({
        todos: [
          { id: "3", blockedBy: [] },
          { id: "1", blocks: [] },
        ],
      });
      expect(
        tasks
          .write({})
          .every((task) => !task.blocks.length && !task.blockedBy.length),
      ).toBe(true);
      const before = tasks.write({});
      for (const todos of [
        [
          { id: "1", blocks: ["3"] },
          { id: "3", blockedBy: [] },
        ],
        [{ subject: "new blocker", blocks: ["2"] }],
      ]) {
        expect(() => tasks.write({ todos })).toThrow();
        expect(tasks.write({})).toEqual(before);
      }
    },
  );

  it.each(["private", "shared"])(
    "rolls back mixed %s batches including deletions and new IDs",
    (kind) => {
      const tasks = board(kind);
      tasks.write({ todos: [{ subject: "first" }, { subject: "second" }] });
      const before = tasks.write({});
      expect(() =>
        tasks.write({
          deleteIds: ["2"],
          todos: [
            { subject: "third" },
            { id: "1", priority: "high", blocks: ["999"] },
          ],
        }),
      ).toThrow("Unknown dependency");
      expect(tasks.write({})).toEqual(before);
      expect(tasks.write({ todos: [{ subject: "third" }] }).at(-1)?.id).toBe(
        "3",
      );
    },
  );

  it("persists and publishes one snapshot for a mixed successful batch", () => {
    const store = new TaskStore("mixed");
    const tasks = new TaskList(store);
    tasks.write({ todos: [{ subject: "first" }, { subject: "second" }] });
    const changed = vi.fn();
    tasks.subscribe(changed);
    changed.mockClear();
    const save = vi.spyOn(store, "save");
    tasks.write({
      deleteIds: ["2"],
      todos: [
        { id: "1", status: "completed" },
        { subject: "third", blockedBy: ["1"] },
      ],
    });
    expect(save).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledOnce();
    expect(changed.mock.calls[0]?.[0]).toEqual(
      new TaskList(new TaskStore("mixed")).list(),
    );
  });

  it("advertises strict, complete fields and aborts before any mutation", async () => {
    const tasks = new TaskList();
    const tool = new TodoWriteTool(tasks);
    const schema = tool.schema().input_schema;
    expect(schema).toMatchObject({
      additionalProperties: false,
      properties: {
        todos: {
          items: {
            additionalProperties: false,
            properties: {
              priority: { enum: ["high", "medium", "low"] },
              owner: { type: "string" },
              metadata: { type: "object" },
              blocks: { type: "array" },
              blockedBy: { type: "array" },
            },
          },
        },
      },
    });
    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await tool.execute(
          { cwd: temporaryDirectory(), abortSignal: controller.signal },
          { todos: [{ subject: "cancelled" }] },
        )
      ).isError,
    ).toBe(true);
    expect(tasks.list()).toEqual([]);
    expect(tasks.write({ todos: [{ subject: "next" }] })[0]?.id).toBe("1");
  });

  it("checks assignments inside the team transaction and notifies only committed tasks", async () => {
    const manager = new TeamManager(temporaryDirectory());
    try {
      const team = manager.create("squad");
      const alice = team.addMember("alice");
      const send = vi.spyOn(alice.mailbox, "sendSync");
      const tool = new TeamTodoWriteTool(manager, "squad");
      const ctx = { cwd: temporaryDirectory() };
      expect(
        (
          await tool.execute(ctx, {
            todos: [
              { subject: "assigned", owner: "alice" },
              { subject: "invalid", owner: "ghost" },
            ],
          })
        ).isError,
      ).toBe(true);
      expect(send).not.toHaveBeenCalled();
      expect(manager.getTaskStore("squad").write({})).toEqual([]);
      const result = await tool.execute(ctx, {
        todos: [
          { subject: "assigned", owner: "alice", priority: "high" },
          { subject: "unassigned" },
        ],
      });
      expect(result.isError).toBe(false);
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[1]).toContain("TodoWrite");
      expect(JSON.parse(result.output)).toMatchObject({
        todos: [{ id: "1", createdBy: "leader", owner: "alice" }, { id: "2" }],
      });
      const store = manager.getTaskStore("squad");
      const before = store.write({});
      const bobTool = new TeamTodoWriteTool(manager, "squad", "bob");
      for (const input of [
        { deleteIds: ["1"] },
        { todos: [{ id: "1", priority: "low" }] },
        { todos: [{ subject: "assign other", owner: "alice" }] },
      ]) {
        expect((await bobTool.execute(ctx, input)).isError).toBe(true);
        expect(store.write({})).toEqual(before);
      }
    } finally {
      await manager.dispose();
    }
  });
});
