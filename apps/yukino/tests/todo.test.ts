import { existsSync } from "node:fs";

import { describe, it, expect } from "vitest";

import { sessionPath } from "@yukino.js/storage";
import { TaskList } from "@yukino.js/todo";
import { TaskStore } from "@yukino.js/todo/store.js";
describe("todo store-backed persistence", () => {
  it("persists tasks to a sess-scoped file and reloads them", () => {
    const list = new TaskList(new TaskStore("sess1"));
    list.write({
      todos: [{ subject: "first task", description: "do the thing" }],
    });
    list.write({
      todos: [{ subject: "second task", description: "do another" }],
    });
    expect(existsSync(sessionPath("sess1", "tasks.json"))).toBe(true);
    const reloaded = new TaskList(new TaskStore("sess1"));
    expect(reloaded.list()).toHaveLength(2);
    expect(reloaded.list()[0].subject).toBe("first task");
    const next = reloaded
      .write({ todos: [{ subject: "third", description: "more" }] })
      .slice(-1)[0];
    expect(next.id).toBe("3");
  });
  it("persists updates and deletes", () => {
    const list = new TaskList(new TaskStore("s"));
    const t = list
      .write({ todos: [{ subject: "task", description: "desc" }] })
      .slice(-1)[0];
    list.write({ todos: [{ id: t.id, ...{ status: "completed" } }] });
    list.write({ todos: [{ subject: "task2", description: "desc2" }] });
    const reloaded = new TaskList(new TaskStore("s"));
    expect(reloaded.get(t.id)?.status).toBe("completed");
    reloaded.write({ deleteIds: [t.id] });
    const again = new TaskList(new TaskStore("s"));
    expect(again.get(t.id)).toBeUndefined();
    expect(again.list()).toHaveLength(1);
  });
  it("separates tasks by session id", () => {
    new TaskList(new TaskStore("a")).write({
      todos: [{ subject: "for-a", description: "x" }],
    });
    const b = new TaskList(new TaskStore("b"));
    expect(b.list()).toHaveLength(0);
    b.useStore(new TaskStore("a"));
    expect(b.list()).toHaveLength(1);
    expect(b.list()[0].subject).toBe("for-a");
  });
  it("works without a store (in-memory only)", () => {
    const list = new TaskList();
    list.write({ todos: [{ subject: "ephemeral", description: "x" }] });
    expect(list.list()).toHaveLength(1);
  });
});
