import { randomUUID } from "node:crypto";
import { renameSync, existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import { createChildLogger } from "@yukino.js/logger";
import {
  readPrivateFileSync as readFileSync,
  writePrivateFileSync as writeFileSync,
  mkdirPrivateSync as mkdirSync,
} from "@yukino.js/storage/private.js";
import type { Task } from "@yukino.js/todo";
import { validateTaskDependencies } from "@yukino.js/todo/dependencies.js";
import { StoredTaskSchema, TaskSnapshotSchema } from "@yukino.js/todo/store.js";
import {
  applyTodoWrite,
  TodoWriteSchema,
  type TodoWriteInput,
} from "@yukino.js/todo/write.js";
import z, { parse } from "zod";

import {
  SHARED_TASK_INVALID_ID_COUNTER_ERROR,
  SHARED_TASK_UNREADABLE_ERROR,
} from "./constants.js";
import { withFileSyncLock } from "./file-lock.js";

export interface SharedTask extends Task {
  createdBy: string;
}

const SerializedTaskSchema = StoredTaskSchema.extend({
  createdBy: z.string(),
});

const StoreDataSchema = TaskSnapshotSchema.extend({
  tasks: z.array(SerializedTaskSchema),
});

type StoreData = z.infer<typeof StoreDataSchema>;
const log = createChildLogger({ module: "shared-tasks" });

export interface SharedTodoWriteOptions {
  actor?: string;
  createdBy?: string;
  validateOwner?: (owner: string) => void;
}

/**
 * Shared task store: persisted as a JSON file (tasks.json), readable and writable by all members of the same team.
 * Every mutation runs under an exclusive file lock (see file-lock.ts) and reloads from disk inside
 * the lock, so cross-process teammates cannot collide on IDs or overwrite each other's changes.
 */
export class SharedTaskStore {
  private path: string;
  private nextId = 1;
  private tasks: SharedTask[] = [];
  private listeners = new Set<(tasks: SharedTask[]) => void>();

  constructor(path: string) {
    this.path = path;
    this.load();
  }

  subscribe(listener: (tasks: SharedTask[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private load(): void {
    if (!existsSync(this.path)) {
      this.tasks = [];
      this.nextId = 1;
      return;
    }
    try {
      const raw: unknown = JSON.parse(readFileSync(this.path, "utf-8"));
      const data = parse(StoreDataSchema, raw);
      const tasks = data.tasks;
      validateTaskDependencies(tasks);
      if (tasks.some((task) => Number(task.id) >= data.nextId)) {
        throw new Error(SHARED_TASK_INVALID_ID_COUNTER_ERROR);
      }
      this.nextId = data.nextId;
      this.tasks = tasks;
    } catch (error) {
      throw new Error(SHARED_TASK_UNREADABLE_ERROR, {
        cause: error,
      });
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const data: StoreData = {
      nextId: this.nextId,
      tasks: this.tasks,
    };
    // Write-then-rename so a concurrent reader (or a crash) never sees a
    // truncated JSON file.
    const tmpPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      renameSync(tmpPath, this.path);
    } finally {
      rmSync(tmpPath, { force: true });
    }
  }

  private mutate<T>(operation: () => T): T {
    const result = withFileSyncLock(this.path, () => {
      this.load();
      const previousTasks = this.tasks;
      const previousId = this.nextId;
      this.tasks = structuredClone(previousTasks);
      try {
        const result = operation();
        if (result !== undefined && result !== false) {
          validateTaskDependencies(this.tasks);
          this.save();
        }
        return structuredClone(result);
      } catch (error) {
        this.tasks = previousTasks;
        this.nextId = previousId;
        throw error;
      }
    });
    if (result !== undefined && result !== false) {
      for (const listener of this.listeners) {
        try {
          listener(structuredClone(this.tasks));
        } catch (error) {
          log.error({ error }, "shared task subscriber failed");
        }
      }
    }
    return result;
  }

  write(
    input: TodoWriteInput,
    options: SharedTodoWriteOptions = {},
  ): SharedTask[] {
    const parsed = TodoWriteSchema.parse(input);
    if (!parsed.todos?.length && !parsed.deleteIds?.length) {
      return this.listTasks();
    }
    return this.mutate(() => {
      const result = applyTodoWrite(this.tasks, this.nextId, parsed, {
        actor: options.actor,
        validateOwner: options.validateOwner,
        createTask: (task) => ({ ...task, createdBy: options.createdBy ?? "" }),
      });
      this.tasks = result.tasks;
      this.nextId = result.nextId;
      return this.tasks;
    });
  }

  /** Retrieves a task by id; reloads from disk first to get the latest state. Returns undefined if not found. */
  get(id: string): SharedTask | undefined {
    this.load();
    return structuredClone(this.tasks.find((t) => t.id === id));
  }

  listTasks(status?: string, owner?: string): SharedTask[] {
    this.load();
    return structuredClone(
      this.tasks.filter((t) => {
        if (status && t.status !== status) {
          return false;
        }
        if (owner && t.owner !== owner) {
          return false;
        }
        return true;
      }),
    );
  }

  releaseOwner(owner: string): SharedTask[] {
    return (
      this.mutate(() => {
        const released: SharedTask[] = [];
        for (const task of this.tasks) {
          if (
            task.owner === owner &&
            task.status !== "completed" &&
            task.status !== "cancelled"
          ) {
            task.owner = "";
            task.status = "pending";
            released.push(task);
          }
        }
        return released.length ? released : undefined;
      }) ?? []
    );
  }

  /** Clears the task store and persists the empty state; used for initialization when creating a new team. */
  initEmpty(): void {
    this.mutate(() => {
      this.tasks = [];
      this.nextId = 1;
      return true;
    });
  }
}
