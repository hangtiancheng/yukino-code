import {
  BackgroundTaskStore,
  type StoredBackgroundTask,
} from "./task-store.js";

import { createChildLogger } from "@/logger/index.js";
import { asErrorString } from "@/utils/index.js";

const log = createChildLogger({ module: "tasks" });

// Finished tasks kept in memory (with their outputs) before the oldest are
// evicted; see TaskManager.pruneCompleted.
const MAX_RETAINED_FINISHED_TASKS = 200;
let nextTaskId = 1;

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
  error?: string;
  transcriptPath?: string;
  startedAt: number;
  completedAt?: number;
  cancel: () => void;
  done: Promise<void>;
}

interface CreateTaskOptions {
  transcriptPath?: string;
  originToolCallId?: string;
  /** ID prefix; defaults to "agent" (background subagents). Bash background tasks use "bash"; PowerShell background tasks use "ps". */
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
  private pendingTaskIds = new Set<string>();
  private store?: BackgroundTaskStore;

  constructor(sessionId?: string) {
    if (sessionId) {
      this.useSession(sessionId);
    }
  }

  useSession(sessionId: string): void {
    if (this.pendingTaskIds.size > 0) {
      throw new Error("Stop and await tasks before switching their session");
    }
    const store = new BackgroundTaskStore(sessionId);
    const records = store.load();
    this.tasks.clear();
    this.notifiedTaskIds.clear();
    this.store = store;
    for (const record of records) {
      nextTaskId = Math.max(
        nextTaskId,
        Number(record.id.split("-").at(-1)) + 1,
      );
      const task = this.restore(record);
      if (task.status === "running") {
        task.status = "failed";
        task.error = "Task interrupted before completion (session restored)";
        task.output = `${task.output}${task.output ? "\n\n" : ""}${task.error}`;
        task.completedAt = Date.now();
        record.notified = false;
        this.persist(task);
      }
      this.tasks.set(task.id, task);
      if (record.notified) {
        this.notifiedTaskIds.add(task.id);
      }
    }
    this.pruneCompleted();
    this.emitChange();
  }

  private restore(record: StoredBackgroundTask): AgentTask {
    const { notified: _notified, ...task } = record;
    return { ...task, cancel: () => undefined, done: Promise.resolve() };
  }

  private persist(task: AgentTask): void {
    const { cancel: _cancel, done: _done, ...record } = task;
    this.store?.save({
      ...record,
      notified: this.notifiedTaskIds.has(task.id),
    });
  }

  create(
    name: string,
    runner: (task: AgentTask) => Promise<string>,
    cancel: () => void,
    options: CreateTaskOptions = {},
  ): AgentTask {
    const id = `${options.idPrefix ?? "agent"}-${String(nextTaskId++)}`;
    const task: AgentTask = {
      id,
      name,
      ...(options.originToolCallId
        ? { originToolCallId: options.originToolCallId }
        : {}),
      ...(options.kind ? { kind: options.kind } : {}),
      status: "running",
      output: "",
      startedAt: Date.now(),
      transcriptPath: options.transcriptPath,
      cancel,
      done: Promise.resolve(),
    };
    this.tasks.set(id, task);
    this.pendingTaskIds.add(id);

    task.done = Promise.resolve()
      .then(() => (task.status === "cancelled" ? task.output : runner(task)))
      .then((output) => {
        if (task.status === "running") {
          task.status = "completed";
          task.output = output;
          this.emitChange(task);
        }
        // A late result after cancellation is discarded: the task stays
        // cancelled with its "Stopped by user" output (pinned contract for
        // background agents; shell kills always surface through TaskFailure
        // in the catch branch instead).
      })
      .catch((error: unknown) => {
        if (task.status === "running") {
          task.status = "failed";
          task.error =
            error instanceof TaskFailure ? error.output : asErrorString(error);
          task.output =
            error instanceof TaskFailure
              ? error.output
              : `Error: ${asErrorString(error)}`;
          this.emitChange(task);
        } else if (
          task.status === "cancelled" &&
          error instanceof TaskFailure
        ) {
          // A stopped task whose runner still produced deliberately formatted
          // output (e.g. a killed background shell command's captured output
          // and exit facts): keep it instead of the generic "Stopped by user"
          // placeholder — the status attribute already says "cancelled".
          // Plain Errors (e.g. an aborted background agent's rejection) stay
          // discarded.
          task.output = error.output;
          this.emitChange(task);
        }
      })
      .finally(() => {
        task.cancel = () => undefined;
        task.completedAt = Date.now();
        this.pendingTaskIds.delete(id);
        this.emitChange(task);
      });

    this.emitChange(task);
    return task;
  }

  get(id: string): AgentTask | undefined {
    const task = this.tasks.get(id);
    if (task) {
      return task;
    }
    const record = this.store?.get(id);
    return record ? this.restore(record) : undefined;
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

  private emitChange(task?: AgentTask): void {
    if (task) {
      this.persist(task);
    }
    const tasks = this.list();
    for (const listener of this.listeners) {
      try {
        listener(tasks);
      } catch (error) {
        log.error({ error }, "task subscriber failed");
      }
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
    try {
      task.cancel();
    } catch (error) {
      log.error({ error, taskId: id }, "task cancellation callback failed");
    } finally {
      this.emitChange(task);
    }
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
    // Loop instead of a one-shot snapshot: tasks can be created while earlier
    // ones settle (e.g. a runner spawning follow-ups); each pass stops and
    // awaits whatever is still pending until nothing new appears.
    const stopped = new Set<string>();
    while (true) {
      const running = this.list().filter(
        (task) => this.pendingTaskIds.has(task.id) && !stopped.has(task.id),
      );
      if (running.length === 0) {
        break;
      }
      for (const task of running) {
        stopped.add(task.id);
        this.stop(task.id);
      }
      await Promise.allSettled(running.map((task) => task.done));
    }
  }

  /**
   * Wait for tasks to settle. An optional filter selects which tasks to wait
   * for (e.g. print-mode waits only for agent-kind tasks: shell tasks may
   * run indefinitely and are stopped, not awaited, at exit).
   */
  async waitAll(filter?: (task: AgentTask) => boolean): Promise<void> {
    while (true) {
      const tasks = this.list().filter(
        (task) => this.pendingTaskIds.has(task.id) && (!filter || filter(task)),
      );
      if (tasks.length === 0) {
        return;
      }
      await Promise.allSettled(tasks.map((task) => task.done));
    }
  }

  async wait(
    id: string,
    options: { timeoutMs: number; abortSignal?: AbortSignal },
  ): Promise<{ task: AgentTask; timedOut: boolean } | undefined> {
    if (
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 0 ||
      options.timeoutMs > 60_000
    ) {
      throw new Error("Task wait timeout must be between 0 and 60000ms");
    }
    const task = this.get(id);
    if (!task) {
      return undefined;
    }
    options.abortSignal?.throwIfAborted();
    if (!this.pendingTaskIds.has(id)) {
      return { task, timedOut: false };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const timeout = new Promise<boolean>((resolve, reject) => {
        timer = setTimeout(() => {
          resolve(true);
        }, options.timeoutMs);
        abort = () => {
          const reason: unknown = options.abortSignal?.reason;
          reject(
            reason instanceof Error
              ? reason
              : new Error("Task wait interrupted"),
          );
        };
        options.abortSignal?.addEventListener("abort", abort, { once: true });
      });
      const timedOut = await Promise.race([
        task.done.then(() => false),
        timeout,
      ]);
      return { task, timedOut };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      if (abort) {
        options.abortSignal?.removeEventListener("abort", abort);
      }
    }
  }

  hasNotifications(): boolean {
    return this.list().some(
      (task) =>
        task.status !== "running" &&
        !this.pendingTaskIds.has(task.id) &&
        !this.notifiedTaskIds.has(task.id),
    );
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
      this.persist(task);
    }
    this.pruneCompleted();
    return completed;
  }

  /**
   * Evicts the oldest finished tasks beyond the retention cap. Without this,
   * a long session accumulates every task (with its full output) in memory
   * forever; running tasks are never dropped.
   */
  private pruneCompleted(): void {
    const finished = this.list().filter(
      (task) =>
        task.status !== "running" &&
        !this.pendingTaskIds.has(task.id) &&
        this.notifiedTaskIds.has(task.id),
    );
    let excess = finished.length - MAX_RETAINED_FINISHED_TASKS;
    const changed = excess > 0;
    for (const task of finished) {
      if (excess <= 0) {
        break;
      }
      this.tasks.delete(task.id);
      this.notifiedTaskIds.delete(task.id);
      excess--;
    }
    if (changed) {
      this.emitChange();
    }
  }

  clear(): void {
    if (this.pendingTaskIds.size > 0) {
      throw new Error("Stop and await tasks before clearing their manager");
    }
    this.tasks.clear();
    this.notifiedTaskIds.clear();
    this.emitChange();
  }
}

export function formatAgentTaskNotification(task: AgentTask): string {
  return [
    `<task-notification task_id="${task.id}" status="${task.status}">`,
    `name=${task.name}`,
    ...(task.transcriptPath ? [`transcript_path=${task.transcriptPath}`] : []),
    task.output,
    "</task-notification>",
  ].join("\n");
}
