import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderToString } from "ink";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createToolRegistry } from "@/bootstrap/tool-registry.js";
import { PermissionChecker } from "@/permissions/index.js";
import { sessionPath } from "@/storage/paths.js";
import { TaskManager } from "@/subagent/task-manager.js";
import {
  cloneRegistryForFork,
  cloneRegistryForTeammate,
  filterToolsForAgent,
} from "@/subagent/tool-filter.js";
import { SharedTaskStore } from "@/teams/shared-task.js";
import { TaskList } from "@/todo/index.js";
import { TaskStore } from "@/todo/store.js";
import { TaskUpdateTool, TodoWriteTool } from "@/todo/tools.js";
import { attachBackgroundTaskManager } from "@/tools/shell-background.js";
import { TaskOutputTool } from "@/tools/task-output.js";
import { TodoProgress } from "@/ui/todo-progress.js";

const directories: string[] = [];
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "yukino-task-regression-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("atomic task/TODO list", () => {
  it("updates fields and both dependency directions in one persisted transaction", async () => {
    const cwd = temporaryDirectory();
    const store = new TaskStore("session");
    const list = new TaskList(store);
    const first = list.create("first", "one");
    const second = list.create("second", "two");
    const save = vi.spyOn(store, "save");
    const result = await new TaskUpdateTool(list).execute(
      { cwd },
      {
        taskId: first.id,
        status: "in_progress",
        addBlocks: [second.id],
        priority: "high",
        metadata: { evidence: "tests" },
      },
    );
    expect(result.isError).toBe(false);
    expect(save).toHaveBeenCalledOnce();
    const restored = new TaskList(new TaskStore("session"));
    expect(restored.get(first.id)).toMatchObject({
      status: "in_progress",
      blocks: [second.id],
      priority: "high",
    });
    expect(restored.get(second.id)?.blockedBy).toEqual([first.id]);
  });
  it("rolls back scalar updates and links on unknown, self, or cyclic dependencies", () => {
    const list = new TaskList();
    const a = list.create("a", "a");
    const b = list.create("b", "b");
    list.addBlocks(a.id, [b.id]);
    const before = list.list();
    for (const dependency of [a.id, b.id, "missing"]) {
      expect(() =>
        list.update(b.id, { subject: "changed", addBlocks: [dependency] }),
      ).toThrow();
      expect(list.list()).toEqual(before);
    }
  });
  it.each(["addBlocks", "addBlockedBy"] as const)(
    "rejects future IDs in %s without retaining partial links or publishing changes",
    (field) => {
      const list = new TaskList();
      const first = list.create("first", "");
      const second = list.create("second", "");
      const changes = vi.fn();
      list.subscribe(changes);
      const before = list.list();
      expect(() =>
        list.update(first.id, {
          status: "in_progress",
          [field]: [second.id, "3"],
        }),
      ).toThrow("Unknown dependency");
      expect(list.list()).toEqual(before);
      expect(changes).toHaveBeenCalledOnce();
      const third = list.create("third", "");
      expect(third.id).toBe("3");
      expect(third.blocks).toEqual([]);
      expect(third.blockedBy).toEqual([]);
      expect(list.get(first.id)).toEqual(first);
      expect(list.get(second.id)).toEqual(second);
    },
  );
  it("removes dangling links on delete and bulk replacement", () => {
    const list = new TaskList();
    const a = list.create("a", "");
    const b = list.create("b", "");
    const c = list.create("c", "");
    list.addBlocks(a.id, [b.id]);
    list.addBlocks(b.id, [c.id]);
    list.delete(b.id);
    expect(list.get(a.id)?.blocks).toEqual([]);
    expect(list.get(c.id)?.blockedBy).toEqual([]);
    list.addBlocks(a.id, [c.id]);
    list.replace([{ id: c.id, subject: "c", status: "pending" }]);
    expect(list.get(c.id)?.blockedBy).toEqual([]);
  });
  it("preserves identity and metadata when replacing TODOs, rejecting duplicate and unknown IDs", async () => {
    const list = new TaskList();
    const a = list.create("a", "description", "Working");
    list.update(a.id, {
      owner: "leader",
      metadata: { count: 2 },
      priority: "high",
    });
    const tool = new TodoWriteTool(list);
    const result = await tool.execute(
      { cwd: "/tmp" },
      {
        todos: [
          { id: a.id, subject: "new title", status: "completed" },
          { subject: "next", status: "pending" },
        ],
      },
    );
    expect(result.isError).toBe(false);
    expect(list.get(a.id)).toMatchObject({
      owner: "leader",
      description: "description",
      metadata: { count: 2 },
      priority: "high",
      activeForm: "Working",
    });
    expect(list.list()[1]?.id).toBe("2");
    const before = list.list();
    for (const todos of [
      [{ id: "missing", subject: "bad", status: "pending" }],
      [
        { id: a.id, subject: "a", status: "pending" },
        { id: a.id, subject: "duplicate", status: "pending" },
      ],
    ]) {
      expect((await tool.execute({ cwd: "/tmp" }, { todos })).isError).toBe(
        true,
      );
      expect(list.list()).toEqual(before);
    }
    expect((await tool.execute({ cwd: "/tmp" }, { todos: [] })).isError).toBe(
      false,
    );
    expect(list.list()).toEqual([]);
  });
  it("does not mutate memory or consume IDs when persistence fails", () => {
    const store = new TaskStore("s");
    const list = new TaskList(store);
    const save = vi.spyOn(store, "save").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => list.create("a", "")).toThrow("disk full");
    expect(list.list()).toEqual([]);
    save.mockRestore();
    expect(list.create("a", "").id).toBe("1");
    const before = list.list();
    vi.spyOn(store, "save").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => list.update("1", { status: "completed" })).toThrow();
    expect(list.list()).toEqual(before);
  });
  it("returns isolated snapshots and publishes only successful commits", () => {
    const list = new TaskList();
    const received = vi.fn();
    const unsubscribe = list.subscribe(received);
    const created = list.create("original", "");
    created.subject = "external mutation";
    list.list()[0].blocks.push("missing");
    expect(list.get(created.id)?.subject).toBe("original");
    expect(list.get(created.id)?.blocks).toEqual([]);
    expect(() => {
      list.addBlocks(created.id, ["missing"]);
    }).toThrow();
    expect(received).toHaveBeenCalledTimes(2);
    unsubscribe();
    list.update(created.id, { status: "completed" });
    expect(received).toHaveBeenCalledTimes(2);
  });
  it("refuses corrupt stores rather than overwriting their contents", () => {
    mkdirSync(sessionPath("s"), { recursive: true });
    const path = sessionPath("s", "tasks.json");
    writeFileSync(path, "broken");
    expect(() => new TaskList(new TaskStore("s"))).toThrow("unreadable");
    expect(readFileSync(path, "utf8")).toBe("broken");
    expect(() => new TaskStore("../../outside")).toThrow(
      "Invalid task list ID",
    );
  });
  it("rejects invalid statuses and blank TODO titles without changing the list", async () => {
    const list = new TaskList();
    const item = list.create("a", "");
    expect(
      (
        await new TaskUpdateTool(list).execute(
          { cwd: "/tmp" },
          { taskId: item.id, status: "nonsense" },
        )
      ).isError,
    ).toBe(true);
    expect(
      (
        await new TodoWriteTool(list).execute(
          { cwd: "/tmp" },
          { todos: [{ subject: "  ", status: "pending" }] },
        )
      ).isError,
    ).toBe(true);
    expect(list.list()).toHaveLength(1);
  });
  it.each(["subagent", "background", "fork", "teammate"])(
    "isolates %s private tasks from the parent and siblings",
    async (kind) => {
      const rootList = new TaskList();
      rootList.create("parent task", "");
      const root = createToolRegistry("/tmp", rootList);
      const clone = () =>
        kind === "fork"
          ? cloneRegistryForFork(root)
          : kind === "teammate"
            ? cloneRegistryForTeammate(root)
            : filterToolsForAgent(
                root,
                undefined,
                undefined,
                kind === "background",
              );
      const child = clone();
      const sibling = clone();
      expect(
        (
          await child
            .get("TaskCreate")
            ?.execute(
              { cwd: "/tmp" },
              { subject: "child task", description: "" },
            )
        )?.isError,
      ).toBe(false);
      expect(
        (await child.get("TaskList")?.execute({ cwd: "/tmp" }, {}))?.output,
      ).toContain("child task");
      expect(
        (await sibling.get("TaskList")?.execute({ cwd: "/tmp" }, {}))?.output,
      ).toBe("No tasks found\nTODO 0/0");
      expect(rootList.list()[0]?.subject).toBe("parent task");
    },
  );
  it("keeps bookkeeping and semantic navigation available in plan without enabling edits", () => {
    const checker = new PermissionChecker("/tmp", "plan");
    checker.mode = "plan";
    for (const name of [
      "TodoWrite",
      "TaskCreate",
      "TaskOutput",
      "LSP",
      "WebSearch",
    ]) {
      expect(
        checker.check(name, "read", { file_path: "/tmp/example.ts" }).effect,
      ).toBe("allow");
    }
    expect(
      checker.check("WriteFile", "write", { file_path: "/tmp/example.ts" })
        .effect,
    ).toBe("deny");
  });
  it("renders bounded progress and honest cancelled/blocked counts", () => {
    const list = new TaskList();
    list.replace([
      { subject: "done", status: "completed" },
      { subject: "work", activeForm: "Testing", status: "in_progress" },
      { subject: "stuck", status: "blocked" },
      { subject: "dropped", status: "cancelled" },
    ]);
    const text = renderToString(
      createElement(TodoProgress, { tasks: list.list() }),
      { columns: 120 },
    );
    expect(text).toContain("TODO 1/4");
    expect(text).toContain("1 cancelled");
    expect(text).toContain("1 blocked");
    expect(text).toContain("Testing");
    expect(renderToString(createElement(TodoProgress, { tasks: [] }))).toBe("");
  });
  it("keeps progress on one line and strips terminal control sequences", () => {
    const list = new TaskList();
    list.replace([
      {
        subject: "work",
        activeForm: "Testing\n\u001b[31mprogress🙂\u001b[0m\tfiles\u0007",
        status: "in_progress",
      },
    ]);
    const text = renderToString(
      createElement(TodoProgress, { tasks: list.list() }),
      { columns: 120 },
    );
    expect(text).toContain("Testing progress🙂 files");
    expect(text.split("\n")).toHaveLength(1);
    expect(text).not.toContain("\u0007");
    expect(text).not.toContain("\u001b[31m");
  });
});

describe("strict shared task transactions", () => {
  it.each(["blocks", "blockedBy"] as const)(
    "rejects forward references in %s at creation and never auto-links later tasks",
    (direction) => {
      const path = join(temporaryDirectory(), "tasks.json");
      const firstHost = new SharedTaskStore(path);
      const secondHost = new SharedTaskStore(path);
      firstHost.create("first");
      const before = readFileSync(path, "utf8");
      for (const dependency of ["2", "3"]) {
        expect(() =>
          secondHost.create(
            "invalid",
            "",
            "",
            direction === "blocks" ? ["1", dependency] : [],
            direction === "blockedBy" ? ["1", dependency] : [],
          ),
        ).toThrow();
        expect(readFileSync(path, "utf8")).toBe(before);
      }
      expect(firstHost.create("second").id).toBe("2");
      expect(secondHost.create("third").id).toBe("3");
      for (const task of firstHost.listTasks()) {
        expect(task.blocks).toEqual([]);
        expect(task.blockedBy).toEqual([]);
      }
    },
  );
  it.each(["addBlocks", "addBlockedBy"] as const)(
    "rolls back partial %s links and honors the latest board across hosts",
    (field) => {
      const path = join(temporaryDirectory(), "tasks.json");
      const leader = new SharedTaskStore(path);
      const teammate = new SharedTaskStore(path);
      const first = leader.create("first");
      const second = teammate.create("second");
      const before = readFileSync(path, "utf8");
      expect(() =>
        leader.update(first.id, {
          owner: "new owner",
          [field]: [second.id, "3"],
        }),
      ).toThrow("Unknown dependency");
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(teammate.get(first.id)).toEqual(first);
      expect(teammate.get(second.id)).toEqual(second);
      teammate.create("third");
      expect(leader.get("3")).toMatchObject({ blocks: [], blockedBy: [] });
      leader.update(first.id, { addBlocks: [second.id] });
      expect(() =>
        teammate.update(second.id, {
          status: "completed",
          addBlocks: [first.id],
        }),
      ).toThrow("cycle");
      expect(leader.get(second.id)).toMatchObject({
        status: "pending",
        blocks: [],
        blockedBy: [first.id],
      });
    },
  );
  it("rejects missing, self and cyclic dependencies without changing disk or scalar fields", () => {
    const path = join(temporaryDirectory(), "tasks.json");
    const store = new SharedTaskStore(path);
    const a = store.create("a");
    const b = store.create("b", "", "", [], [a.id]);
    const before = readFileSync(path, "utf8");
    for (const dependency of [a.id, b.id, "missing"]) {
      expect(() =>
        store.update(b.id, {
          status: "completed",
          owner: "new owner",
          addBlocks: [dependency],
        }),
      ).toThrow();
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(store.get(b.id)).toMatchObject({
        status: "pending",
        owner: "",
        blocks: [],
      });
    }
    expect(() => store.create("future dependency", "", "", ["4"])).toThrow(
      "Unknown dependency",
    );
    expect(store.create("next").id).toBe("3");
  });
  it("supports cancellation and removes reciprocal links on deletion", () => {
    const path = join(temporaryDirectory(), "tasks.json");
    const store = new SharedTaskStore(path);
    const a = store.create("a");
    const b = store.create("b", "", "", [], [a.id]);
    const c = store.create("c", "", "", [], [b.id]);
    store.update(b.id, { status: "cancelled" });
    expect(store.listTasks("cancelled").map((task) => task.id)).toEqual([b.id]);
    expect(store.delete(b.id)).toBe(true);
    expect(store.delete(b.id)).toBe(false);
    const restored = new SharedTaskStore(path);
    expect(restored.get(a.id)?.blocks).toEqual([]);
    expect(restored.get(c.id)?.blockedBy).toEqual([]);
    expect(restored.create("new").id).toBe("4");
  });
  it("returns snapshots that cannot mutate cached or persisted records", () => {
    const store = new SharedTaskStore(join(temporaryDirectory(), "tasks.json"));
    const created = store.create("a");
    created.subject = "uncommitted";
    created.blocks.push("missing");
    store.listTasks()[0].owner = "uncommitted";
    expect(store.get(created.id)).toMatchObject({
      subject: "a",
      owner: "",
      blocks: [],
    });
    const updated = store.update(created.id, { description: "saved" });
    if (updated) {
      updated.description = "uncommitted";
    }
    expect(store.get(created.id)?.description).toBe("saved");
  });
  it("rolls back memory, counters and links on persistence failure", () => {
    const path = join(temporaryDirectory(), "tasks.json");
    const store = new SharedTaskStore(path);
    const a = store.create("a");
    const b = store.create("b");
    const before = readFileSync(path, "utf8");
    const save: unknown = Reflect.get(store, "save");
    Reflect.set(store, "save", () => {
      throw new Error("disk full");
    });
    expect(() => store.create("c")).toThrow("disk full");
    expect(Reflect.get(store, "nextId")).toBe(3);
    expect(() =>
      store.update(a.id, { status: "completed", addBlocks: [b.id] }),
    ).toThrow("disk full");
    expect(Reflect.get(store, "tasks")).toMatchObject([
      { id: a.id, status: "pending", blocks: [] },
      { id: b.id, blockedBy: [] },
    ]);
    expect(readFileSync(path, "utf8")).toBe(before);
    Reflect.set(store, "save", save);
    expect(store.create("c").id).toBe("3");
  });
  it("reports corrupt boards on reads too and never repairs invalid stored dependencies", () => {
    const path = join(temporaryDirectory(), "tasks.json");
    const store = new SharedTaskStore(path);
    store.create("a");
    const corrupt = JSON.stringify({
      next_id: 2,
      tasks: [
        {
          id: "1",
          subject: "a",
          description: "",
          status: "pending",
          owner: "",
          blocks: ["2"],
          blockedBy: [],
          createdBy: "",
        },
      ],
    });
    writeFileSync(path, corrupt);
    for (const operation of [
      () => store.listTasks(),
      () => store.get("1"),
      () => store.create("next"),
      () => {
        store.initEmpty();
      },
    ]) {
      expect(operation).toThrow("unreadable");
      expect(readFileSync(path, "utf8")).toBe(corrupt);
    }
    expect(() => new SharedTaskStore(path)).toThrow("unreadable");
  });
  it("rejects empty titles and invalid statuses without writing", () => {
    const path = join(temporaryDirectory(), "tasks.json");
    const store = new SharedTaskStore(path);
    const a = store.create("a");
    const before = readFileSync(path, "utf8");
    expect(() => store.create("  ")).toThrow();
    expect(() => store.update(a.id, { status: "done" })).toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("background task output", () => {
  it("does not start a runner cancelled while queued", async () => {
    const manager = new TaskManager();
    const runner = vi.fn(() => Promise.resolve("work"));
    const cancel = vi.fn();
    const task = manager.create("queued", runner, cancel);
    manager.stop(task.id);
    await task.done;
    expect(runner).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(task.status).toBe("cancelled");
  });
  it("waits for completion without consuming notifications", async () => {
    const manager = new TaskManager();
    const task = manager.create(
      "work",
      () => Promise.resolve("result"),
      () => undefined,
    );
    const result = await new TaskOutputTool(manager).execute(
      { cwd: "/tmp" },
      { task_id: task.id, wait: true },
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('"completed"');
    expect(result.output).toContain('"result"');
    expect(manager.drainNotifications()).toEqual([task]);
  });
  it("timeouts and interruptions leave the task running", async () => {
    const manager = new TaskManager();
    let finish: (output: string) => void = () => undefined;
    const promise = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const task = manager.create(
      "running",
      () => promise,
      () => {
        finish("stopped");
      },
    );
    const tool = new TaskOutputTool(manager);
    const timedOut = await tool.execute(
      { cwd: "/tmp" },
      { task_id: task.id, wait: true, timeout_ms: 0 },
    );
    expect(timedOut.output).toContain('"timed_out": true');
    expect(task.status).toBe("running");
    const controller = new AbortController();
    const waiting = tool.execute(
      { cwd: "/tmp", abortSignal: controller.signal },
      { task_id: task.id, wait: true },
    );
    controller.abort();
    expect((await waiting).isError).toBe(true);
    expect(task.status).toBe("running");
    finish("done");
    await task.done;
  });
  it("uses the invoking agent's task manager and honors disabled background tasks", async () => {
    const parent = new TaskManager();
    const child = new TaskManager();
    const task = parent.create(
      "private",
      () => Promise.resolve("parent"),
      () => undefined,
    );
    await task.done;
    const tool = new TaskOutputTool(parent);
    for (const taskManager of [child, null]) {
      expect(
        (await tool.execute({ cwd: "/tmp", taskManager }, { task_id: task.id }))
          .isError,
      ).toBe(true);
    }
    const registry = createToolRegistry("/tmp", new TaskList());
    attachBackgroundTaskManager(registry, parent);
    expect(
      (
        await registry
          .get("TaskOutput")
          ?.execute({ cwd: "/tmp" }, { task_id: task.id })
      )?.isError,
    ).toBe(false);
  });
  it("isolates subscriber failures and completes cleanup even if cancel callbacks fail", async () => {
    const manager = new TaskManager();
    manager.subscribe((tasks) => {
      if (tasks.length) {
        throw new Error("observer failed");
      }
    });
    const task = manager.create(
      "work",
      () => Promise.resolve("done"),
      () => {
        throw new Error("cancel failed");
      },
    );
    expect(() => manager.stop(task.id)).not.toThrow();
    await manager.stopAll();
    expect(task.status).toBe("cancelled");
    const successful = manager.create(
      "success",
      () => Promise.resolve("done"),
      () => undefined,
    );
    await successful.done;
    expect(successful.status).toBe("completed");
  });
});
