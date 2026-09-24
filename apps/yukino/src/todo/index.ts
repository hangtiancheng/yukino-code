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

import type { StoredTaskStatus, TaskStore } from "./store.js";

// Submodule namespaces for library consumers (Todo.<Sub>.*).
export * as Store from "./store.js";
export * as Tools from "./tools.js";

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
}

export class TaskList {
  private tasks = new Map<string, Task>();
  private nextId = 1;
  private store?: TaskStore;

  // Optional store-backing: when provided, the list loads existing tasks and
  // persists on every mutation so tasks survive a restart / resume.
  constructor(store?: TaskStore) {
    if (store) {
      this.useStore(store);
    }
  }

  // Re-point at a different store (e.g. on session resume) and reload from it.
  useStore(store: TaskStore): void {
    this.store = store;
    this.tasks.clear();
    let maxId = 0;
    for (const t of store.load()) {
      this.tasks.set(t.id, t);
      const n = parseInt(t.id, 10);
      if (!Number.isNaN(n) && n > maxId) {
        maxId = n;
      }
    }
    this.nextId = maxId + 1;
  }

  private persist(): void {
    this.store?.save([...this.tasks.values()]);
  }

  create(subject: string, description: string, activeForm?: string): Task {
    const task: Task = {
      id: String(this.nextId++),
      subject,
      description,
      status: "pending",
      activeForm,
      blocks: [],
      blockedBy: [],
      metadata: {},
    };
    this.tasks.set(task.id, task);
    this.persist();
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  list(): Task[] {
    return [...this.tasks.values()];
  }

  update(id: string, updates: Partial<Omit<Task, "id">>): Task | undefined {
    let task = this.tasks.get(id);
    if (!task) {
      return undefined;
    }
    task = {
      ...task,
      ...updates,
    };
    this.tasks.set(id, task);
    this.persist();
    return task;
  }

  delete(id: string): boolean {
    const ok = this.tasks.delete(id);
    if (ok) {
      this.persist();
    }
    return ok;
  }

  addBlocks(taskId: string, blockedIds: string[]): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }
    for (const id of blockedIds) {
      if (!task.blocks.includes(id)) {
        task.blocks.push(id);
      }
      const blocked = this.tasks.get(id);
      if (blocked && !blocked.blockedBy.includes(taskId)) {
        blocked.blockedBy.push(taskId);
      }
    }
    this.persist();
  }

  addBlockedBy(taskId: string, blockerIds: string[]): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }
    for (const id of blockerIds) {
      if (!task.blockedBy.includes(id)) {
        task.blockedBy.push(id);
      }
      const blocker = this.tasks.get(id);
      if (blocker && !blocker.blocks.includes(taskId)) {
        blocker.blocks.push(taskId);
      }
    }
    this.persist();
  }
}
