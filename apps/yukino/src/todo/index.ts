import {
  unresolvedTaskDependencies,
  validateTaskDependencies,
} from "./dependencies.js";
import type { StoredTaskStatus, TaskStore } from "./store.js";

import { createChildLogger } from "@/logger/index.js";

// Submodule namespaces for library consumers (Todo.<Sub>.*).
export * as Store from "./store.js";
export * as Tools from "./tools.js";
export * as Dependencies from "./dependencies.js";
export * as Progress from "./progress.js";

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: StoredTaskStatus;
  owner?: string;
  activeForm?: string;
  blocks: string[];
  blockedBy: string[];
  metadata: Record<string, unknown>;
  priority?: "high" | "medium" | "low";
}

export interface TodoInput {
  id?: string;
  subject: string;
  description?: string;
  status: StoredTaskStatus;
  activeForm?: string;
  priority?: Task["priority"];
}

export type TaskUpdates = Partial<Omit<Task, "id" | "blocks" | "blockedBy">> & {
  addBlocks?: string[];
  addBlockedBy?: string[];
};

export interface TaskBoard {
  create(
    subject: string,
    description: string,
    activeForm?: string,
    metadata?: Record<string, unknown>,
  ): Task;
  get(id: string): Task | undefined;
  list(): Task[];
  update(id: string, updates: TaskUpdates): Task | undefined;
  delete(id: string): boolean;
}

export function mergeTaskMetadata(
  current: Record<string, unknown>,
  updates: Record<string, unknown> = {},
): Record<string, unknown> {
  const entries = new Map(Object.entries(current));
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) {
      entries.delete(key);
    } else {
      entries.set(key, value);
    }
  }
  return structuredClone(Object.fromEntries(entries));
}

const log = createChildLogger({ module: "todo" });

export class TaskList {
  private tasks = new Map<string, Task>();
  private nextId = 1;
  private store?: TaskStore;
  private listeners = new Set<(tasks: Task[]) => void>();

  // Optional store-backing: when provided, the list loads existing tasks and
  // persists on every mutation so tasks survive a restart / resume.
  constructor(store?: TaskStore) {
    if (store) {
      this.useStore(store);
    }
  }

  // Re-point at a different store (e.g. on session resume) and reload from it.
  useStore(store: TaskStore): void {
    const loaded = store.load();
    const tasks = new Map(loaded.tasks.map((task) => [task.id, task]));
    if (tasks.size !== loaded.tasks.length) {
      throw new Error("Duplicate task IDs in stored list");
    }
    this.validate(tasks);
    this.store = store;
    this.tasks = tasks;
    this.nextId = loaded.nextId;
    this.emitChange();
  }

  private commit(tasks: Map<string, Task>, nextId = this.nextId): void {
    this.validate(tasks);
    this.store?.save([...tasks.values()], nextId);
    this.tasks = tasks;
    this.nextId = nextId;
    this.emitChange();
  }

  subscribe(listener: (tasks: Task[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.list());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.list());
      } catch (error) {
        log.error({ error }, "task subscriber failed");
      }
    }
  }

  private validate(tasks: Map<string, Task>): void {
    for (const task of tasks.values()) {
      if (!task.subject.trim()) {
        throw new Error("Task subject must not be empty");
      }
    }
    validateTaskDependencies(tasks.values());
  }

  create(
    subject: string,
    description: string,
    activeForm?: string,
    metadata: Record<string, unknown> = {},
  ): Task {
    const task: Task = {
      id: String(this.nextId),
      subject,
      description,
      status: "pending",
      activeForm,
      blocks: [],
      blockedBy: [],
      metadata: structuredClone(metadata),
    };
    this.commit(new Map(this.tasks).set(task.id, task), this.nextId + 1);
    return structuredClone(task);
  }

  get(id: string): Task | undefined {
    const task = this.tasks.get(id);
    return task ? structuredClone(task) : undefined;
  }

  list(): Task[] {
    return structuredClone([...this.tasks.values()]);
  }

  update(id: string, updates: TaskUpdates): Task | undefined {
    const tasks = new Map(this.list().map((task) => [task.id, task]));
    let task = tasks.get(id);
    if (!task) {
      return undefined;
    }
    const { addBlocks = [], addBlockedBy = [], ...fields } = updates;
    const metadata = mergeTaskMetadata(task.metadata, fields.metadata);
    task = {
      ...task,
      ...structuredClone(fields),
      metadata,
    };
    tasks.set(id, task);
    const link = (from: string, to: string): void => {
      const blocker = tasks.get(from);
      const blocked = tasks.get(to);
      if (!blocker || !blocked) {
        throw new Error(`Unknown dependency: #${from} → #${to}`);
      }
      if (!blocker.blocks.includes(to)) {
        blocker.blocks.push(to);
      }
      if (!blocked.blockedBy.includes(from)) {
        blocked.blockedBy.push(from);
      }
    };
    for (const blocked of addBlocks) {
      link(id, blocked);
    }
    for (const blocker of addBlockedBy) {
      link(blocker, id);
    }
    if (updates.status === "in_progress") {
      const blockers = unresolvedTaskDependencies(task, tasks.values());
      if (blockers.length) {
        throw new Error(`Task #${id} is blocked by: ${blockers.join(", ")}`);
      }
    }
    this.commit(tasks);
    return structuredClone(task);
  }

  delete(id: string): boolean {
    if (!this.tasks.has(id)) {
      return false;
    }
    const tasks = new Map(
      this.list()
        .filter((task) => task.id !== id)
        .map((task) => [
          task.id,
          {
            ...task,
            blocks: task.blocks.filter((other) => other !== id),
            blockedBy: task.blockedBy.filter((other) => other !== id),
          },
        ]),
    );
    this.commit(tasks);
    return true;
  }

  addBlocks(taskId: string, blockedIds: string[]): void {
    this.update(taskId, { addBlocks: blockedIds });
  }

  addBlockedBy(taskId: string, blockerIds: string[]): void {
    this.update(taskId, { addBlockedBy: blockerIds });
  }

  replace(todos: TodoInput[]): Task[] {
    let nextId = this.nextId;
    const tasks = new Map<string, Task>();
    for (const todo of todos) {
      const previous = todo.id ? this.tasks.get(todo.id) : undefined;
      if (todo.id && !previous) {
        throw new Error(`Task #${todo.id} not found`);
      }
      const id = previous?.id ?? String(nextId++);
      if (tasks.has(id)) {
        throw new Error(`Duplicate task ID: ${id}`);
      }
      tasks.set(id, {
        ...(previous
          ? structuredClone(previous)
          : { owner: undefined, metadata: {}, blocks: [], blockedBy: [] }),
        id,
        subject: todo.subject,
        description: todo.description ?? previous?.description ?? "",
        status: todo.status,
        activeForm: todo.activeForm ?? previous?.activeForm,
        priority: todo.priority ?? previous?.priority,
      });
    }
    for (const task of tasks.values()) {
      task.blocks = task.blocks.filter((id) => tasks.has(id));
      task.blockedBy = task.blockedBy.filter((id) => tasks.has(id));
      if (task.status === "in_progress") {
        const blockers = unresolvedTaskDependencies(task, tasks.values());
        if (blockers.length) {
          throw new Error(
            `Task #${task.id} is blocked by: ${blockers.join(", ")}`,
          );
        }
      }
    }
    this.commit(tasks, nextId);
    return this.list();
  }
}
