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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

import z, { parse } from "zod";

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

// type SerializedTask = z.infer<typeof SerializedTaskSchema>;
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
 * Reloads the file before every read operation to ensure cross-process teammates see the latest data.
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
    writeFileSync(this.path, JSON.stringify(data, null, 2), "utf-8");
  }

  /** Creates a shared task and returns the newly created entry. */
  create(
    title: string,
    description = "",
    assignee = "",
    blocks: string[] = [],
    blockedBy: string[] = [],
    createdBy = "",
  ): SharedTask {
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
  }

  /** Retrieves a task by id; reloads from disk first to get the latest state. Returns undefined if not found. */
  get(id: string): SharedTask | undefined {
    this.load();
    return this.tasks.find((t) => t.id === id);
  }

  /** Lists tasks, optionally filtered by status and/or assignee. */
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
  }

  /** Clears the task store and persists the empty state; used for initialization when creating a new team. */
  initEmpty(): void {
    this.tasks = [];
    this.nextId = 1;
    this.save();
  }
}
