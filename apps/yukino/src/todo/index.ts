import { randomUUID } from "node:crypto";

import { createChildLogger } from "@/logger/index.js";
import { PRIVATE_BOARD_ID_PREFIX } from "@/todo/constants.js";
import { validateTaskDependencies } from "@/todo/dependencies.js";
import type { StoredTask, TaskStore } from "@/todo/store.js";
import {
  applyTodoWrite,
  TodoWriteSchema,
  type TodoWriteInput,
} from "@/todo/write.js";

export * as Constants from "./constants.js";
export * as Dependencies from "./dependencies.js";
export * as Progress from "./progress.js";
export * as Prompts from "./prompts.js";
export * as Store from "./store.js";
export * as Tools from "./tools.js";
export * as Write from "./write.js";

export type Task = StoredTask;
export type { TodoInput, TodoWriteInput } from "./write.js";

export interface TaskBoard {
  readonly boardId: string;
  write(input: TodoWriteInput): Task[];
}

const log = createChildLogger({ module: "todo" });

export class TaskList implements TaskBoard {
  private tasks: Task[] = [];
  private nextId = 1;
  private store?: TaskStore;
  private listeners = new Set<(tasks: Task[]) => void>();
  private memoryId = `${PRIVATE_BOARD_ID_PREFIX}${randomUUID()}`;

  constructor(store?: TaskStore) {
    if (store) {
      this.useStore(store);
    }
  }

  get boardId(): string {
    return this.store?.boardId ?? this.memoryId;
  }

  useStore(store: TaskStore): void {
    const loaded = store.load();
    validateTaskDependencies(loaded.tasks);
    this.store = store;
    this.tasks = loaded.tasks;
    this.nextId = loaded.nextId;
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

  get(id: string): Task | undefined {
    return structuredClone(this.tasks.find((task) => task.id === id));
  }

  list(): Task[] {
    return structuredClone(this.tasks);
  }

  write(input: TodoWriteInput): Task[] {
    const parsed = TodoWriteSchema.parse(input);
    if (!parsed.todos?.length && !parsed.deleteIds?.length) {
      return this.list();
    }
    const result = applyTodoWrite(this.tasks, this.nextId, parsed, {
      createTask: (task) => task,
    });
    this.store?.save(result.tasks, result.nextId);
    this.tasks = result.tasks;
    this.nextId = result.nextId;
    this.emitChange();
    return this.list();
  }
}
