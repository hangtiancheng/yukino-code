/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { describe, expect, it } from "vitest";

import { TaskFailure, TaskManager } from "@/subagent/task-manager.js";

const ok = (): Promise<string> => Promise.resolve("ok");
const noop = (): void => undefined;

describe("TaskManager", () => {
  it("delivers cancelled output only after cleanup and waits on repeated stopAll", async () => {
    const tasks = new TaskManager();
    let reject!: (error: unknown) => void;
    const task = tasks.create(
      "shell",
      () =>
        new Promise<string>((_, fail) => {
          reject = fail;
        }),
      noop,
      { kind: "shell" },
    );
    await Promise.resolve();
    tasks.stop(task.id);
    expect(tasks.drainNotifications()).toEqual([]);
    let stopped = false;
    const stopping = tasks.stopAll().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toBe(false);
    reject(new TaskFailure("captured before stop"));
    await stopping;
    expect(tasks.drainNotifications().map((item) => item.output)).toEqual([
      "captured before stop",
    ]);
    expect(tasks.drainNotifications()).toEqual([]);
  });

  it("records the task kind from create options", async () => {
    const tasks = new TaskManager();
    const shell = tasks.create("s", ok, noop, {
      idPrefix: "bash",
      kind: "shell",
    });
    const agent = tasks.create("a", ok, noop);
    expect(shell.kind).toBe("shell");
    expect(shell.id).toBe("bash-1");
    expect(agent.kind).toBeUndefined();
    await tasks.waitAll();
  });

  it("reports completed notifications without consuming them", async () => {
    const tasks = new TaskManager();
    const task = tasks.create("agent", ok, noop);
    expect(tasks.hasNotifications()).toBe(false);

    await task.done;
    expect(tasks.hasNotifications()).toBe(true);
    expect(tasks.drainNotifications()).toEqual([task]);
    expect(tasks.hasNotifications()).toBe(false);
  });

  it("waitAll(filter) only awaits matching tasks", async () => {
    const tasks = new TaskManager();
    let release!: () => void;
    tasks.create(
      "dev-server",
      () =>
        new Promise<string>((resolve) => {
          release = () => {
            resolve("done");
          };
        }),
      () => {
        release();
      },
      { kind: "shell" },
    );
    tasks.create("quick", ok, noop, { kind: "agent" });

    // Resolves even though the shell task is still running; without the
    // filter this would hang until the test timeout.
    await tasks.waitAll((task) => (task.kind ?? "agent") === "agent");

    release();
    await tasks.waitAll();
    expect(tasks.hasRunning()).toBe(false);
  });

  it("preserves a TaskFailure's output when the task was cancelled", async () => {
    const tasks = new TaskManager();
    let fail!: () => void;
    const task = tasks.create(
      "cmd",
      () =>
        new Promise<string>((_resolve, reject) => {
          fail = () => {
            reject(new TaskFailure("$ cmd\npartial output"));
          };
        }),
      () => {
        fail();
      },
      { kind: "shell" },
    );
    await Promise.resolve();
    expect(tasks.stop(task.id)).toBe(true);
    await task.done;
    expect(task.status).toBe("cancelled");
    // The killed command's formatted output survives the stop instead of the
    // generic placeholder — the status attribute already says "cancelled".
    expect(task.output).toBe("$ cmd\npartial output");
  });

  it("discards a cancelled task's late normal runner output", async () => {
    const tasks = new TaskManager();
    let finish!: (value: string) => void;
    const task = tasks.create(
      "eval",
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
      () => {
        finish("late result");
      },
    );
    await Promise.resolve();
    tasks.stop(task.id);
    finish("late result");
    await task.done;
    expect(task.status).toBe("cancelled");
    // Pinned contract: late results after a stop are discarded; shell kills
    // surface through TaskFailure instead.
    expect(task.output).toBe("Stopped by user");
  });

  it("keeps 'Stopped by user' when a cancelled task's runner rejects generically", async () => {
    const tasks = new TaskManager();
    let fail!: (error: unknown) => void;
    const task = tasks.create(
      "agent-run",
      () =>
        new Promise<string>((_resolve, reject) => {
          fail = reject;
        }),
      () => {
        fail(new Error("This operation was aborted"));
      },
    );
    await Promise.resolve();
    tasks.stop(task.id);
    await task.done;
    expect(task.status).toBe("cancelled");
    // Background Agent tasks reject with plain Errors on abort: those stay
    // discarded so the notification doesn't read "Error: ... aborted".
    expect(task.output).toBe("Stopped by user");
  });
});
