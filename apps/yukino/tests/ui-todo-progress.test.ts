import { stripVTControlCharacters } from "node:util";

import { render, type Instance } from "ink";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskList, type Task } from "@/todo/index.js";
import { TodoProgress } from "@/ui/todo-progress.js";

let instance: Instance | undefined;
let frame = "";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frame = "";
  vi.spyOn(process.stdout, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      frame = stripVTControlCharacters(String(chunk));
      return true;
    },
  );
});

afterEach(() => {
  act(() => {
    instance?.unmount();
    instance?.cleanup();
  });
  instance = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function show(tasks: readonly Task[], sessionId?: string) {
  act(() => {
    const view = createElement(TodoProgress, { tasks, key: sessionId });
    if (instance) {
      instance.rerender(view);
    } else {
      instance = render(view, {
        patchConsole: false,
        interactive: false,
        debug: true,
      });
    }
  });
}

function advance(milliseconds: number) {
  act(() => {
    vi.advanceTimersByTime(milliseconds);
  });
}

describe("TODO progress completion", () => {
  it("hides five seconds after every item completes without changing tasks or IDs", () => {
    const list = new TaskList();
    const first = list.create("first", "");
    const second = list.create("second", "");
    list.update(first.id, { status: "completed" });
    show(list.list());
    advance(10_000);
    expect(frame).toContain("TODO 1/2");

    list.update(second.id, { status: "completed" });
    const completedTasks = list.list();
    show(completedTasks);
    expect(frame).toContain("TODO 2/2");
    advance(4999);
    expect(frame).toContain("TODO 2/2");
    advance(1);
    expect(frame).toBe("");
    expect(list.list()).toEqual(completedTasks);

    const next = list.create("next", "");
    expect(next.id).toBe("3");
    show(list.list());
    expect(frame).toContain("TODO 2/3");
  });

  it("does not restart the countdown or reveal hidden progress on equivalent rerenders", () => {
    const list = new TaskList();
    list.replace([
      { subject: "first", status: "completed" },
      { subject: "second", status: "completed" },
    ]);
    show(list.list());
    advance(4000);
    show(list.list().reverse());
    advance(999);
    expect(frame).toContain("TODO 2/2");
    advance(1);
    expect(frame).toBe("");
    show(list.list());
    expect(frame).toBe("");
  });

  it("cancels a pending hide when work reopens and gives completion a fresh five seconds", () => {
    const list = new TaskList();
    const task = list.create("work", "");
    list.update(task.id, { status: "completed" });
    show(list.list());
    advance(4000);
    list.update(task.id, { status: "in_progress" });
    show(list.list());
    advance(2000);
    expect(frame).toContain("TODO 0/1");

    list.update(task.id, { status: "completed" });
    show(list.list());
    advance(4999);
    expect(frame).toContain("TODO 1/1");
    advance(1);
    expect(frame).toBe("");

    list.update(task.id, { status: "pending" });
    show(list.list());
    expect(frame).toContain("TODO 0/1");
    advance(10_000);
    expect(frame).toContain("TODO 0/1");
  });

  it("starts a fresh countdown for a replacement list of completed tasks", () => {
    const list = new TaskList();
    list.replace([{ subject: "old", status: "completed" }]);
    show(list.list());
    advance(5000);
    expect(frame).toBe("");

    list.replace([{ subject: "new", status: "completed" }]);
    show(list.list());
    expect(frame).toContain("TODO 1/1");
    advance(4999);
    expect(frame).toContain("TODO 1/1");
    advance(1);
    expect(frame).toBe("");
  });

  it("starts a fresh countdown after switching sessions with matching task IDs", () => {
    const list = new TaskList();
    list.replace([{ subject: "done", status: "completed" }]);
    show(list.list(), "first-session");
    advance(4000);
    show(list.list(), "second-session");
    advance(1000);
    expect(frame).toContain("TODO 1/1");
    advance(4000);
    expect(frame).toBe("");

    show(list.list(), "third-session");
    expect(frame).toContain("TODO 1/1");
    advance(5000);
    expect(frame).toBe("");
  });

  it.each(["blocked", "cancelled"] as const)(
    "keeps %s work visible rather than treating it as completed",
    (status) => {
      const list = new TaskList();
      list.replace([
        { subject: "done", status: "completed" },
        { subject: "unfinished", status },
      ]);
      show(list.list());
      advance(10_000);
      expect(frame).toContain("TODO 1/2");
      expect(frame).toContain(status);
    },
  );

  it("cancels the countdown when the list clears or the component unmounts", () => {
    const list = new TaskList();
    list.replace([{ subject: "done", status: "completed" }]);
    show(list.list());
    advance(4000);
    show([]);
    expect(frame).toBe("");
    show(list.list());
    advance(4999);
    expect(frame).toContain("TODO 1/1");
    act(() => {
      instance?.unmount();
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
