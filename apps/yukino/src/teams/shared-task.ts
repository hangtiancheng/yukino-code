import { randomUUID } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { dirname } from "node:path";

import z, { parse } from "zod";

import { withFileSyncLock } from "./file-lock.js";

import { createChildLogger } from "@/logger/index.js";
import {
  unresolvedTaskDependencies,
  validateTaskDependencies,
} from "@/todo/dependencies.js";
import type { Task, TaskUpdates } from "@/todo/index.js";
import { mergeTaskMetadata } from "@/todo/index.js";
import { StoredTaskSchema, StoredTaskStatusSchema } from "@/todo/store.js";

export interface SharedTask extends Task {
  createdBy: string;
}

const SerializedTaskSchema = StoredTaskSchema.extend({
  id: z.string().regex(/^[1-9]\d*$/u),
  createdBy: z.string(),
});

/** Top-level structure of tasks.json: next available id + task list. */
const StoreDataSchema = z.object({
  next_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  tasks: z.array(SerializedTaskSchema),
});

type StoreData = z.infer<typeof StoreDataSchema>;
const log = createChildLogger({ module: "shared-tasks" });

export type TaskUpdateFields = Omit<TaskUpdates, "status"> & {
  status?: string;
};

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
      if (tasks.some((task) => Number(task.id) >= data.next_id)) {
        throw new Error("Invalid shared task ID counter");
      }
      this.nextId = data.next_id;
      this.tasks = tasks;
    } catch (error) {
      throw new Error("Cannot load an unreadable shared task board", {
        cause: error,
      });
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const data: StoreData = {
      next_id: this.nextId,
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

  create(
    subject: string,
    description = "",
    owner = "",
    blocks: string[] = [],
    blockedBy: string[] = [],
    createdBy = "",
    activeForm?: string,
    metadata: Record<string, unknown> = {},
  ): SharedTask {
    return this.mutate(() => {
      const task: SharedTask = {
        id: String(this.nextId++),
        subject: z.string().trim().min(1).parse(subject),
        description,
        status: "pending",
        owner,
        activeForm,
        metadata: structuredClone(metadata),
        blocks: [...blocks],
        blockedBy: [...blockedBy],
        createdBy,
      };
      this.tasks.push(task);
      this.linkDependencies(task);
      return task;
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

  /**
   * Updates task fields; addBlocks / addBlockedBy append dependencies (deduplicated).
   * Returns undefined if the task does not exist.
   */
  update(
    id: string,
    fields: TaskUpdateFields,
    actor?: string,
  ): SharedTask | undefined {
    return this.mutate(() => {
      const task = this.tasks.find((t) => t.id === id);
      if (!task) {
        return undefined;
      }
      this.assertOwner(task, actor);
      if (actor && fields.owner && fields.owner !== actor) {
        throw new Error("Only the leader can assign tasks to other teammates");
      }
      if (actor && fields.status === "in_progress") {
        if (task.status === "completed" || task.status === "cancelled") {
          throw new Error(
            `Task #${id} is already ${task.status}; reopen it as pending first`,
          );
        }
        task.owner = actor;
      }
      if (fields.status !== undefined) {
        task.status = StoredTaskStatusSchema.parse(fields.status);
      }
      if (fields.owner !== undefined) {
        task.owner = fields.owner;
      }
      if (fields.description !== undefined) {
        task.description = fields.description;
      }
      if (fields.subject !== undefined) {
        task.subject = z.string().trim().min(1).parse(fields.subject);
      }
      if (fields.activeForm !== undefined) {
        task.activeForm = fields.activeForm;
      }
      if (fields.priority !== undefined) {
        task.priority = fields.priority;
      }
      task.metadata = mergeTaskMetadata(task.metadata, fields.metadata);
      for (const b of fields.addBlocks ?? []) {
        if (!task.blocks.includes(b)) {
          task.blocks.push(b);
        }
      }
      for (const b of fields.addBlockedBy ?? []) {
        if (!task.blockedBy.includes(b)) {
          task.blockedBy.push(b);
        }
      }
      this.linkDependencies(task);
      if (actor && task.status === "in_progress" && !task.owner) {
        throw new Error("An in-progress teammate task must have an owner");
      }
      if (fields.status === "in_progress") {
        const blockers = unresolvedTaskDependencies(task, this.tasks);
        if (blockers.length) {
          throw new Error(`Task #${id} is blocked by: ${blockers.join(", ")}`);
        }
        const busy =
          actor &&
          this.tasks.find(
            (other) =>
              other.id !== id &&
              other.owner === actor &&
              other.status === "in_progress",
          );
        if (busy) {
          throw new Error(
            `Teammate '${actor}' is already working on task #${busy.id}`,
          );
        }
      }
      return task;
    });
  }

  delete(id: string, actor?: string): boolean {
    return this.mutate(() => {
      const existing = this.tasks.find((task) => task.id === id);
      if (!existing) {
        return false;
      }
      this.assertOwner(existing, actor);
      this.tasks = this.tasks.filter((task) => task.id !== id);
      for (const task of this.tasks) {
        task.blocks = task.blocks.filter((dependency) => dependency !== id);
        task.blockedBy = task.blockedBy.filter(
          (dependency) => dependency !== id,
        );
      }
      return true;
    });
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

  private assertOwner(task: SharedTask, actor?: string): void {
    if (actor && task.owner && task.owner !== actor) {
      throw new Error(`Task #${task.id} is already claimed by '${task.owner}'`);
    }
  }

  /** Clears the task store and persists the empty state; used for initialization when creating a new team. */
  initEmpty(): void {
    this.mutate(() => {
      this.tasks = [];
      this.nextId = 1;
      return true;
    });
  }

  private linkDependencies(task: SharedTask): void {
    task.blocks = [...new Set(task.blocks)];
    task.blockedBy = [...new Set(task.blockedBy)];
    for (const blockedId of task.blocks) {
      const blocked = this.tasks.find(
        (candidate) => candidate.id === blockedId,
      );
      if (!blocked) {
        throw new Error(
          `Unknown dependency: task #${blockedId} does not exist`,
        );
      }
      if (!blocked.blockedBy.includes(task.id)) {
        blocked.blockedBy.push(task.id);
      }
    }
    for (const blockerId of task.blockedBy) {
      const blocker = this.tasks.find(
        (candidate) => candidate.id === blockerId,
      );
      if (!blocker) {
        throw new Error(
          `Unknown dependency: task #${blockerId} does not exist`,
        );
      }
      if (!blocker.blocks.includes(task.id)) {
        blocker.blocks.push(task.id);
      }
    }
  }
}
