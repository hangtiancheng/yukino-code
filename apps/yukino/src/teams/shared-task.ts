import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { dirname } from "node:path";

import z, { parse } from "zod";

import { withFileSyncLock } from "./file-lock.js";

/** A task on the team's shared task board, with dependency relations (blocks / blockedBy) and ownership (assignee). */
export interface SharedTask {
  id: string;
  title: string;
  description: string;
  status: string; // pending | in_progress | completed | blocked
  assignee: string;
  blocks: string[];
  blockedBy: string[];
  createdBy: string;
}

/** On-disk task structure; field names use snake_case for cross-language consistency. */
const SerializedTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().default(""),
  status: z.string().default("pending"),
  assignee: z.string().default(""),
  blocks: z.array(z.string()).default([]),
  blocked_by: z.array(z.string()).default([]),
  created_by: z.string().default(""),
});

/** Top-level structure of tasks.json: next available id + task list. */
const StoreDataSchema = z.object({
  next_id: z.number().int().positive().default(1),
  tasks: z.array(SerializedTaskSchema).default([]),
});

type StoreData = z.infer<typeof StoreDataSchema>;

export interface TaskUpdateFields {
  status?: string;
  assignee?: string;
  description?: string;
  addBlocks?: string[];
  addBlockedBy?: string[];
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

  constructor(path: string) {
    this.path = path;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) {
      return;
    }
    try {
      const raw: unknown = JSON.parse(readFileSync(this.path, "utf-8"));
      const data = parse(StoreDataSchema, raw);
      this.nextId = data.next_id;
      this.tasks = data.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        assignee: t.assignee,
        blocks: t.blocks,
        blockedBy: t.blocked_by,
        createdBy: t.created_by,
      }));
    } catch {
      // On read failure, keep the in-memory state intact; do not disrupt the main flow
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const data: StoreData = {
      next_id: this.nextId,
      tasks: this.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        assignee: t.assignee,
        blocks: t.blocks,
        blocked_by: t.blockedBy,
        created_by: t.createdBy,
      })),
    };
    // Write-then-rename so a concurrent reader (or a crash) never sees a
    // truncated JSON file.
    const tmpPath = `${this.path}.${String(process.pid)}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmpPath, this.path);
  }

  create(
    title: string,
    description = "",
    assignee = "",
    blocks: string[] = [],
    blockedBy: string[] = [],
    createdBy = "",
  ): SharedTask {
    return withFileSyncLock(this.path, () => {
      // Reload inside the lock: the in-memory counter is stale whenever
      // another process created tasks since our last read, and reusing it
      // would collide IDs and let this save overwrite the other's tasks.
      this.load();
      const task: SharedTask = {
        id: String(this.nextId++),
        title,
        description,
        status: "pending",
        assignee,
        blocks: [...blocks],
        blockedBy: [...blockedBy],
        createdBy,
      };
      this.tasks.push(task);
      this.save();
      return task;
    });
  }

  /** Retrieves a task by id; reloads from disk first to get the latest state. Returns undefined if not found. */
  get(id: string): SharedTask | undefined {
    this.load();
    return this.tasks.find((t) => t.id === id);
  }

  listTasks(status?: string, assignee?: string): SharedTask[] {
    this.load();
    return this.tasks.filter((t) => {
      if (status && t.status !== status) {
        return false;
      }
      if (assignee && t.assignee !== assignee) {
        return false;
      }
      return true;
    });
  }

  /**
   * Updates task fields; addBlocks / addBlockedBy append dependencies (deduplicated).
   * Returns undefined if the task does not exist.
   */
  update(id: string, fields: TaskUpdateFields): SharedTask | undefined {
    return withFileSyncLock(this.path, () => {
      this.load();
      const task = this.tasks.find((t) => t.id === id);
      if (!task) {
        return undefined;
      }
      if (fields.status !== undefined) {
        task.status = fields.status;
      }
      if (fields.assignee !== undefined) {
        task.assignee = fields.assignee;
      }
      if (fields.description !== undefined) {
        task.description = fields.description;
      }
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
      this.save();
      return task;
    });
  }

  /** Clears the task store and persists the empty state; used for initialization when creating a new team. */
  initEmpty(): void {
    withFileSyncLock(this.path, () => {
      this.tasks = [];
      this.nextId = 1;
      this.save();
    });
  }
}
