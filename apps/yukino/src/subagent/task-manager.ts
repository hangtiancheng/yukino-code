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

import { asErrorString } from "@/utils/index.js";

export type AgentTaskStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * What a task wraps. Hosts use this to wait selectively: print-mode blocks on
 * agent tasks (their results feed the final answer) but must not block on
 * shell tasks, which can run indefinitely (dev servers) and are killed at
 * exit instead. Absent kind means "agent" (the original TaskManager use).
 */
export type TaskKind = "agent" | "shell";

export interface AgentTask {
  id: string;
  name: string;
  originToolCallId?: string;
  kind?: TaskKind;
  status: AgentTaskStatus;
  output: string;
  cancel: () => void;
  done: Promise<void>;
}

interface CreateTaskOptions {
  originToolCallId?: string;
  /** ID prefix; defaults to "agent" (background subagents). Bash background tasks use "bash". */
  idPrefix?: string;
  /** Task category; defaults to "agent". */
  kind?: TaskKind;
}

/**
 * A runner failure that carries its own pre-formatted output. TaskManager
 * stores `output` verbatim on the failed task instead of the generic
 * `Error: <message>` wrapper, so tool-level results (e.g. a background Bash
 * command's captured output and exit code) reach the notification intact.
 */
export class TaskFailure extends Error {
  constructor(readonly output: string) {
    super("task failed");
  }
}

export class TaskManager {
  private tasks = new Map<string, AgentTask>();
  private notifiedTaskIds = new Set<string>();
  private listeners = new Set<(tasks: AgentTask[]) => void>();
  private nextId = 1;
  private pendingTaskIds = new Set<string>();

  create(
    name: string,
    runner: (task: AgentTask) => Promise<string>,
    cancel: () => void,
    options: CreateTaskOptions = {},
  ): AgentTask {
    const id = `${options.idPrefix ?? "agent"}-${String(this.nextId++)}`;
    const task: AgentTask = {
      id,
      name,
      ...(options.originToolCallId
        ? { originToolCallId: options.originToolCallId }
        : {}),
      ...(options.kind ? { kind: options.kind } : {}),
      status: "running",
      output: "",
      cancel,
      done: Promise.resolve(),
    };
    this.tasks.set(id, task);
    this.pendingTaskIds.add(id);

    task.done = Promise.resolve()
      .then(() => runner(task))
      .then((output) => {
        if (task.status === "running") {
          task.status = "completed";
          task.output = output;
          this.emitChange();
        }
        // A late result after cancellation is discarded: the task stays
        // cancelled with its "Stopped by user" output (pinned contract for
        // background agents; shell kills always surface through TaskFailure
        // in the catch branch instead).
      })
      .catch((error: unknown) => {
        if (task.status === "running") {
          task.status = "failed";
          task.output =
            error instanceof TaskFailure
              ? error.output
              : `Error: ${asErrorString(error)}`;
          this.emitChange();
        } else if (
          task.status === "cancelled" &&
          error instanceof TaskFailure
        ) {
          // A stopped task whose runner still produced deliberately formatted
          // output (e.g. a killed background shell command's captured output
          // and exit facts): keep it instead of the generic "Stopped by user"
          // placeholder — the status attribute already says "cancelled".
          // Plain Errors (an aborted background agent's rejection, a stopped
          // JS evaluation's dispose fallout rethrown plainly) stay discarded.
          task.output = error.output;
          this.emitChange();
        }
      })
      .finally(() => {
        this.pendingTaskIds.delete(id);
        this.emitChange();
      });

    this.emitChange();
    return task;
  }

  get(id: string): AgentTask | undefined {
    return this.tasks.get(id);
  }

  list(): AgentTask[] {
    return [...this.tasks.values()];
  }

  subscribe(listener: (tasks: AgentTask[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.list());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitChange(): void {
    const tasks = this.list();
    for (const listener of this.listeners) {
      listener(tasks);
    }
  }

  hasRunning(): boolean {
    return this.list().some((task) => task.status === "running");
  }

  stop(id: string): boolean {
    const task = this.tasks.get(id);
    if (task?.status !== "running") {
      return false;
    }
    task.status = "cancelled";
    task.output = "Stopped by user";
    task.cancel();
    this.emitChange();
    return true;
  }

  async stopAndWait(id: string): Promise<boolean> {
    const task = this.tasks.get(id);
    if (!task) {
      return false;
    }
    const stopped = this.stop(id);
    await task.done;
    return stopped;
  }

  async stopAll(): Promise<void> {
    const running = this.list().filter((task) =>
      this.pendingTaskIds.has(task.id),
    );
    for (const task of running) {
      this.stop(task.id);
    }
    await Promise.allSettled(running.map((task) => task.done));
  }

  /**
   * Wait for tasks to settle. An optional filter selects which tasks to wait
   * for (e.g. print-mode waits only for agent-kind tasks: shell tasks may
   * run indefinitely and are stopped, not awaited, at exit).
   */
  async waitAll(filter?: (task: AgentTask) => boolean): Promise<void> {
    const tasks = filter ? this.list().filter(filter) : this.list();
    await Promise.allSettled(tasks.map((task) => task.done));
  }

  drainNotifications(): AgentTask[] {
    const completed = this.list().filter(
      (task) =>
        task.status !== "running" &&
        !this.pendingTaskIds.has(task.id) &&
        !this.notifiedTaskIds.has(task.id),
    );
    for (const task of completed) {
      this.notifiedTaskIds.add(task.id);
    }
    return completed;
  }

  clear(): void {
    this.tasks.clear();
    this.notifiedTaskIds.clear();
    this.emitChange();
  }
}

export function formatAgentTaskNotification(task: AgentTask): string {
  return [
    `<task-notification task_id="${task.id}" status="${task.status}">`,
    `name=${task.name}`,
    task.output,
    "</task-notification>",
  ].join("\n");
}
