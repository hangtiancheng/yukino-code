import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createToolRegistry } from "@yukino.js/bootstrap/tool-registry.js";
import { PermissionChecker } from "@yukino.js/permissions";
import { sessionPath } from "@yukino.js/storage";
import { TaskManager } from "@yukino.js/subagent/task-manager.js";
import {
  cloneRegistryForTeammate,
  filterToolsForAgent,
} from "@yukino.js/subagent/tool-filter.js";
import { SharedTaskStore } from "@yukino.js/teams/shared-task.js";
import { TaskList } from "@yukino.js/todo";
import { TaskStore } from "@yukino.js/todo/store.js";
import { TodoWriteTool } from "@yukino.js/todo/tools.js";
import { attachBackgroundTaskManager } from "@yukino.js/tools/shell-background.js";
import { TaskOutputTool } from "@yukino.js/tools/task-output.js";
import { TodoProgress } from "@yukino.js/ui/todo-progress.js";
import { renderToString } from "ink";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    const first = list
      .write({ todos: [{ subject: "first", description: "one" }] })
      .slice(-1)[0];
    const second = list
      .write({ todos: [{ subject: "second", description: "two" }] })
      .slice(-1)[0];
    const save = vi.spyOn(store, "save");
    const result = await new TodoWriteTool(list).execute(
      { cwd },
      {
        todos: [
          {
            id: first.id,
            status: "in_progress",
            blocks: [second.id],
            priority: "high",
            metadata: { evidence: "tests" },
          },
        ],
      },
    );
    expect(result.isError).toBe(false);
    expect(save).toHaveBeenCalledOnce();
    const restored = new TaskList(new TaskStore("session"));
    expect(restored.get(first.id)).toMatchObject({
      status: "in_progress",
      blocks: [second.id],
      priority: "high",
      metadata: { evidence: "tests" },
    });
    expect(restored.get(second.id)?.blockedBy).toEqual([first.id]);
  });
  it("rolls back scalar updates and links on unknown, self, or cyclic dependencies", () => {
    const list = new TaskList();
    const a = list
      .write({ todos: [{ subject: "a", description: "a" }] })
      .slice(-1)[0];
    const b = list
      .write({ todos: [{ subject: "b", description: "b" }] })
      .slice(-1)[0];
    list.write({ todos: [{ id: a.id, blocks: [b.id] }] });
    const before = list.list();
    for (const dependency of [a.id, b.id, "missing"]) {
      expect(() =>
        list
          .write({
            todos: [
              {
                id: b.id,
                ...{
                  subject: "changed",
                  metadata: { leaked: true },
                  blocks: [dependency],
                },
              },
            ],
          })
          .find((task) => task.id === b.id),
      ).toThrow();
      expect(list.list()).toEqual(before);
    }
  });
  it.each(["blocks", "blockedBy"] as const)(
    "rejects future IDs in %s without retaining partial links or publishing changes",
    (field) => {
      const list = new TaskList();
      const first = list
        .write({ todos: [{ subject: "first", description: "" }] })
        .slice(-1)[0];
      const second = list
        .write({ todos: [{ subject: "second", description: "" }] })
        .slice(-1)[0];
      const changes = vi.fn();
      list.subscribe(changes);
      const before = list.list();
      expect(() =>
        list
          .write({
            todos: [
              {
                id: first.id,
                ...{
                  status: "in_progress",
                  [field]: [second.id, "3"],
                },
              },
            ],
          })
          .find((task) => task.id === first.id),
      ).toThrow("Unknown dependency");
      expect(list.list()).toEqual(before);
      expect(changes).toHaveBeenCalledOnce();
      const third = list
        .write({ todos: [{ subject: "third", description: "" }] })
        .slice(-1)[0];
      expect(third.id).toBe("3");
      expect(third.blocks).toEqual([]);
      expect(third.blockedBy).toEqual([]);
      expect(list.get(first.id)).toEqual(first);
      expect(list.get(second.id)).toEqual(second);
    },
  );
  it("removes reciprocal links on task deletion and explicit dependency replacement", () => {
    const list = new TaskList();
    const a = list
      .write({ todos: [{ subject: "a", description: "" }] })
      .slice(-1)[0];
    const b = list
      .write({ todos: [{ subject: "b", description: "" }] })
      .slice(-1)[0];
    const c = list
      .write({ todos: [{ subject: "c", description: "" }] })
      .slice(-1)[0];
    list.write({ todos: [{ id: a.id, blocks: [b.id] }] });
    list.write({ todos: [{ id: b.id, blocks: [c.id] }] });
    list.write({ deleteIds: [b.id] });
    expect(list.get(a.id)?.blocks).toEqual([]);
    expect(list.get(c.id)?.blockedBy).toEqual([]);
    list.write({ todos: [{ id: a.id, blocks: [c.id] }] });
    list.write({ todos: [{ id: c.id, blockedBy: [] }] });
    expect(list.get(c.id)?.blockedBy).toEqual([]);
  });
  it("preserves identity and metadata in incremental edits, rejecting duplicate and unknown IDs", async () => {
    const list = new TaskList(new TaskStore("metadata-todos"));
    expect(
      (
        await new TodoWriteTool(list).execute(
          { cwd: "/tmp" },
          {
            todos: [
              {
                subject: "a",
                description: "description",
                metadata: { count: 2 },
              },
            ],
          },
        )
      ).isError,
    ).toBe(false);
    const [a] = list.list();
    expect(
      (
        await new TodoWriteTool(list).execute(
          { cwd: "/tmp" },
          {
            todos: [
              {
                id: a.id,
                owner: "leader",
                priority: "high",
              },
            ],
          },
        )
      ).isError,
    ).toBe(false);
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
    });
    expect(list.list()[1]?.id).toBe("2");
    expect(
      new TaskList(new TaskStore("metadata-todos")).get(a.id)?.metadata,
    ).toEqual({ count: 2 });
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
    expect(list.list()).toEqual(before);
  });
  it("does not mutate memory or consume IDs when persistence fails", () => {
    const store = new TaskStore("s");
    const list = new TaskList(store);
    const save = vi.spyOn(store, "save").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(
      () =>
        list.write({ todos: [{ subject: "a", description: "" }] }).slice(-1)[0],
    ).toThrow("disk full");
    expect(list.list()).toEqual([]);
    save.mockRestore();
    expect(
      list.write({ todos: [{ subject: "a", description: "" }] }).slice(-1)[0]
        .id,
    ).toBe("1");
    const before = list.list();
    vi.spyOn(store, "save").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() =>
      list
        .write({ todos: [{ id: "1", ...{ status: "completed" } }] })
        .find((task) => task.id === "1"),
    ).toThrow();
    expect(list.list()).toEqual(before);
  });
  it("returns isolated snapshots and publishes only successful commits", () => {
    const list = new TaskList();
    const received = vi.fn();
    const unsubscribe = list.subscribe(received);
    const created = list
      .write({ todos: [{ subject: "original", description: "" }] })
      .slice(-1)[0];
    created.subject = "external mutation";
    list.list()[0].blocks.push("missing");
    expect(list.get(created.id)?.subject).toBe("original");
    expect(list.get(created.id)?.blocks).toEqual([]);
    expect(() => {
      list.write({ todos: [{ id: created.id, blocks: ["missing"] }] });
    }).toThrow();
    expect(received).toHaveBeenCalledTimes(2);
    unsubscribe();
    list.write({ todos: [{ id: created.id, ...{ status: "completed" } }] });
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
    const item = list
      .write({ todos: [{ subject: "a", description: "" }] })
      .slice(-1)[0];
    expect(
      (
        await new TodoWriteTool(list).execute(
          { cwd: "/tmp" },
          { todos: [{ id: item.id, status: "nonsense" }] },
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
  it("rejects malformed TODO IDs without replacing existing items or consuming IDs", async () => {
    const list = new TaskList();
    const item = list
      .write({ todos: [{ subject: "original", description: "" }] })
      .slice(-1)[0];
    const write = new TodoWriteTool(list);
    for (const id of [1, "", "0", "01", "-1", "1.0", " 1 ", "1\n", "task-1"]) {
      const result = await write.execute(
        { cwd: "/tmp" },
        { todos: [{ id, subject: "must not change", status: "pending" }] },
      );
      expect(result.isError).toBe(true);
      expect(result.output).toContain("id");
      expect(list.list()).toEqual([item]);
    }
    expect(
      list.write({ todos: [{ subject: "next", description: "" }] }).slice(-1)[0]
        .id,
    ).toBe("2");
  });
  it.each(["subagent", "background", "fork", "teammate"])(
    "isolates %s private tasks from the parent and siblings",
    async (kind) => {
      const rootList = new TaskList();
      rootList.write({ todos: [{ subject: "parent task", description: "" }] });
      const root = createToolRegistry("/tmp", rootList);
      const clone = () =>
        kind === "fork"
          ? filterToolsForAgent(root, undefined, undefined, false)
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
            .get("TodoWrite")
            ?.execute(
              { cwd: "/tmp" },
              { todos: [{ subject: "child task", description: "" }] },
            )
        )?.isError,
      ).toBe(false);
      expect(
        (await child.get("TodoWrite")?.execute({ cwd: "/tmp" }, {}))?.output,
      ).toContain("child task");
      const empty = await sibling
        .get("TodoWrite")
        ?.execute({ cwd: "/tmp" }, {});
      expect(JSON.parse(empty?.output ?? "null")).toMatchObject({
        todos: [],
        progress: "TODO 0/0",
      });
      expect(rootList.list()[0]?.subject).toBe("parent task");
    },
  );
  it("keeps bookkeeping and semantic navigation available in plan without enabling edits", () => {
    const checker = new PermissionChecker("/tmp", "plan");
    checker.mode = "plan";
    for (const name of ["TodoWrite", "TaskOutput", "LSP", "WebFetch"]) {
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
    list.write({
      todos: [
        { subject: "done", status: "completed" },
        { subject: "Testing", status: "in_progress" },
        { subject: "stuck", status: "blocked" },
        { subject: "dropped", status: "cancelled" },
      ],
    });
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
    list.write({
      todos: [
        {
          subject: "Testing\n\u001b[31mprogress🙂\u001b[0m\tfiles\u0007",
          status: "in_progress",
        },
      ],
    });
    const text = renderToString(
      createElement(TodoProgress, { tasks: list.list() }),
      { columns: 120 },
    );
    expect(text).toContain("Testing progress🙂  files");
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
      firstHost.write({ todos: [{ subject: "first" }] });
      const before = readFileSync(path, "utf8");
      for (const dependency of ["2", "3"]) {
        expect(
          () =>
            secondHost
              .write({
                todos: [
                  {
                    subject: "invalid",
                    description: "",
                    owner: "",
                    blocks: direction === "blocks" ? ["1", dependency] : [],
                    blockedBy:
                      direction === "blockedBy" ? ["1", dependency] : [],
                  },
                ],
              })
              .slice(-1)[0],
        ).toThrow();
        expect(readFileSync(path, "utf8")).toBe(before);
      }
      expect(
        firstHost.write({ todos: [{ subject: "second" }] }).slice(-1)[0].id,
      ).toBe("2");
      expect(
        secondHost.write({ todos: [{ subject: "third" }] }).slice(-1)[0].id,
      ).toBe("3");
      for (const task of firstHost.listTasks()) {
        expect(task.blocks).toEqual([]);
        expect(task.blockedBy).toEqual([]);
      }
    },
  );
  it.each(["blocks", "blockedBy"] as const)(
    "rolls back partial %s links and honors the latest board across hosts",
    (field) => {
      const path = join(temporaryDirectory(), "tasks.json");
      const leader = new SharedTaskStore(path);
      const teammate = new SharedTaskStore(path);
      const first = leader
        .write({ todos: [{ subject: "first" }] })
        .slice(-1)[0];
      const second = teammate
        .write({ todos: [{ subject: "second" }] })
        .slice(-1)[0];
      const before = readFileSync(path, "utf8");
      expect(() =>
        leader
          .write({
            todos: [
              {
                id: first.id,
                ...{
                  owner: "new owner",
                  [field]: [second.id, "3"],
                },
              },
            ],
          })
          .find((task) => task.id === first.id),
      ).toThrow("Unknown dependency");
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(teammate.get(first.id)).toEqual(first);
      expect(teammate.get(second.id)).toEqual(second);
      teammate.write({ todos: [{ subject: "third" }] });
      expect(leader.get("3")).toMatchObject({ blocks: [], blockedBy: [] });
      leader.write({ todos: [{ id: first.id, ...{ blocks: [second.id] } }] });
      expect(() =>
        teammate
          .write({
            todos: [
              {
                id: second.id,
                ...{
                  status: "completed",
                  blocks: [first.id],
                },
              },
            ],
          })
          .find((task) => task.id === second.id),
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
    const a = store.write({ todos: [{ subject: "a" }] }).slice(-1)[0];
    const b = store
      .write({
        todos: [
          {
            subject: "b",
            description: "",
            owner: "",
            blocks: [],
            blockedBy: [a.id],
          },
        ],
      })
      .slice(-1)[0];
    const before = readFileSync(path, "utf8");
    for (const dependency of [a.id, b.id, "missing"]) {
      expect(() =>
        store
          .write({
            todos: [
              {
                id: b.id,
                ...{
                  status: "completed",
                  owner: "new owner",
                  blocks: [dependency],
                },
              },
            ],
          })
          .find((task) => task.id === b.id),
      ).toThrow();
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(store.get(b.id)).toMatchObject({
        status: "pending",
        owner: "",
        blocks: [],
      });
    }
    expect(
      () =>
        store
          .write({
            todos: [
              {
                subject: "future dependency",
                description: "",
                owner: "",
                blocks: ["4"],
              },
            ],
          })
          .slice(-1)[0],
    ).toThrow("Unknown dependency");
    expect(store.write({ todos: [{ subject: "next" }] }).slice(-1)[0].id).toBe(
      "3",
    );
  });
  it("supports cancellation and removes reciprocal links on deletion", () => {
    const path = join(temporaryDirectory(), "tasks.json");
    const store = new SharedTaskStore(path);
    const a = store.write({ todos: [{ subject: "a" }] }).slice(-1)[0];
    const b = store
      .write({
        todos: [
          {
            subject: "b",
            description: "",
            owner: "",
            blocks: [],
            blockedBy: [a.id],
          },
        ],
      })
      .slice(-1)[0];
    const c = store
      .write({
        todos: [
          {
            subject: "c",
            description: "",
            owner: "",
            blocks: [],
            blockedBy: [b.id],
          },
        ],
      })
      .slice(-1)[0];
    store.write({ todos: [{ id: b.id, ...{ status: "cancelled" } }] });
    expect(store.listTasks("cancelled").map((task) => task.id)).toEqual([b.id]);
    expect(store.write({ deleteIds: [b.id] }).map((task) => task.id)).toEqual([
      a.id,
      c.id,
    ]);
    expect(() => store.write({ deleteIds: [b.id] })).toThrow("not found");
    const restored = new SharedTaskStore(path);
    expect(restored.get(a.id)?.blocks).toEqual([]);
    expect(restored.get(c.id)?.blockedBy).toEqual([]);
    expect(
      restored.write({ todos: [{ subject: "new" }] }).slice(-1)[0].id,
    ).toBe("4");
  });
  it("returns snapshots that cannot mutate cached or persisted records", () => {
    const store = new SharedTaskStore(join(temporaryDirectory(), "tasks.json"));
    const created = store.write({ todos: [{ subject: "a" }] }).slice(-1)[0];
    created.subject = "uncommitted";
    created.blocks.push("missing");
    store.listTasks()[0].owner = "uncommitted";
    expect(store.get(created.id)).toMatchObject({
      subject: "a",
      owner: "",
      blocks: [],
    });
    const updated = store
      .write({ todos: [{ id: created.id, ...{ description: "saved" } }] })
      .find((task) => task.id === created.id);
    if (updated) {
      updated.description = "uncommitted";
    }
    expect(store.get(created.id)?.description).toBe("saved");
  });
  it("rolls back memory, counters and links on persistence failure", () => {
    const path = join(temporaryDirectory(), "tasks.json");
    const store = new SharedTaskStore(path);
    const a = store.write({ todos: [{ subject: "a" }] }).slice(-1)[0];
    const b = store.write({ todos: [{ subject: "b" }] }).slice(-1)[0];
    const before = readFileSync(path, "utf8");
    const save: unknown = Reflect.get(store, "save");
    Reflect.set(store, "save", () => {
      throw new Error("disk full");
    });
    expect(
      () => store.write({ todos: [{ subject: "c" }] }).slice(-1)[0],
    ).toThrow("disk full");
    expect(Reflect.get(store, "nextId")).toBe(3);
    expect(() =>
      store
        .write({
          todos: [{ id: a.id, ...{ status: "completed", blocks: [b.id] } }],
        })
        .find((task) => task.id === a.id),
    ).toThrow("disk full");
    expect(Reflect.get(store, "tasks")).toMatchObject([
      { id: a.id, status: "pending", blocks: [] },
      { id: b.id, blockedBy: [] },
    ]);
    expect(readFileSync(path, "utf8")).toBe(before);
    Reflect.set(store, "save", save);
    expect(store.write({ todos: [{ subject: "c" }] }).slice(-1)[0].id).toBe(
      "3",
    );
  });
  it("reports corrupt boards on reads too and never repairs invalid stored dependencies", () => {
    const path = join(temporaryDirectory(), "tasks.json");
    const store = new SharedTaskStore(path);
    store.write({ todos: [{ subject: "a" }] });
    const corrupt = JSON.stringify({
      nextId: 2,
      tasks: [
        {
          id: "1",
          subject: "a",
          description: "",
          status: "pending",
          owner: "",
          blocks: ["2"],
          blockedBy: [],
          metadata: {},
          createdBy: "",
        },
      ],
    });
    writeFileSync(path, corrupt);
    for (const operation of [
      () => store.listTasks(),
      () => store.get("1"),
      () => store.write({ todos: [{ subject: "next" }] }).slice(-1)[0],
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
    const a = store.write({ todos: [{ subject: "a" }] }).slice(-1)[0];
    const before = readFileSync(path, "utf8");
    expect(
      () => store.write({ todos: [{ subject: "  " }] }).slice(-1)[0],
    ).toThrow();
    expect(() => {
      Reflect.apply(store.write.bind(store), undefined, [
        { todos: [{ id: a.id, status: "done" }] },
      ]);
    }).toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
describe("task snapshot validation", () => {
  it.each(["private", "shared"])(
    "validates IDs and nextId consistently in %s storage and retains the counter after deletion",
    (board) => {
      const path =
        board === "shared"
          ? join(temporaryDirectory(), "tasks.json")
          : sessionPath("snapshot", "tasks.json");
      const load = () =>
        board === "shared"
          ? new SharedTaskStore(path)
          : new TaskList(new TaskStore("snapshot"));
      const store = load();
      const task = store.write({ todos: [{ subject: "first" }] }).slice(-1)[0];
      const snapshot = { nextId: 2, tasks: [task] };
      for (const invalid of [
        { ...snapshot, nextId: undefined },
        { ...snapshot, nextId: 0 },
        { ...snapshot, nextId: 1 },
        { ...snapshot, nextId: 2.5 },
        { ...snapshot, nextId: Number.MAX_SAFE_INTEGER + 1 },
        { ...snapshot, tasks: [{ ...task, id: "01" }] },
        { ...snapshot, tasks: [{ ...task, blocks: ["01"] }] },
        { ...snapshot, tasks: [{ ...task, blockedBy: ["01"] }] },
      ]) {
        const serialized = JSON.stringify(invalid);
        writeFileSync(path, serialized);
        expect(load).toThrow("unreadable");
        expect(readFileSync(path, "utf8")).toBe(serialized);
      }
      writeFileSync(path, JSON.stringify(snapshot));
      expect(load().write({ deleteIds: [task.id] })).toEqual([]);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        nextId: 2,
        tasks: [],
      });
      expect(
        load()
          .write({ todos: [{ subject: "next" }] })
          .slice(-1)[0].id,
      ).toBe("2");
    },
  );
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
