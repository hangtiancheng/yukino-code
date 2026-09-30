import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { TaskList } from "@/todo/index.js";
import { TaskStore } from "@/todo/store.js";

describe("todo store-backed persistence", () => {
  it("persists tasks to a sess-scoped file and reloads them", () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-todo-"));
    const list = new TaskList(new TaskStore(workDir, "sess1"));
    list.create("first task", "do the thing");
    list.create("second task", "do another");

    expect(existsSync(join(workDir, ".yukino", "tasks", "sess1.json"))).toBe(
      true,
    );

    // A fresh list over the same store recovers the tasks and continues ids.
    const reloaded = new TaskList(new TaskStore(workDir, "sess1"));
    expect(reloaded.list()).toHaveLength(2);
    expect(reloaded.list()[0].subject).toBe("first task");
    const next = reloaded.create("third", "more");
    expect(next.id).toBe("3");
  });

  it("persists updates and deletes", () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-todo-"));
    const list = new TaskList(new TaskStore(workDir, "s"));
    const t = list.create("task", "desc");
    list.update(t.id, { status: "completed" });
    list.create("task2", "desc2");

    const reloaded = new TaskList(new TaskStore(workDir, "s"));
    expect(reloaded.get(t.id)?.status).toBe("completed");

    reloaded.delete(t.id);
    const again = new TaskList(new TaskStore(workDir, "s"));
    expect(again.get(t.id)).toBeUndefined();
    expect(again.list()).toHaveLength(1);
  });

  it("separates tasks by session id", () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-todo-"));
    new TaskList(new TaskStore(workDir, "a")).create("for-a", "x");
    const b = new TaskList(new TaskStore(workDir, "b"));
    expect(b.list()).toHaveLength(0);

    // useStore repoints at session a's tasks.
    b.useStore(new TaskStore(workDir, "a"));
    expect(b.list()).toHaveLength(1);
    expect(b.list()[0].subject).toBe("for-a");
  });

  it("works without a store (in-memory only)", () => {
    const list = new TaskList();
    list.create("ephemeral", "x");
    expect(list.list()).toHaveLength(1);
  });
});
