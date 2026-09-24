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
import { join, dirname } from "node:path";

import z, { parse } from "zod";

import { createChildLogger } from "@/logger/index.js";

const log = createChildLogger({ module: "todo" });

const StoredTaskStatusSchema = z.enum(["pending", "in_progress", "completed"]);

export type StoredTaskStatus = z.infer<typeof StoredTaskStatusSchema>;

const StoredTaskSchema = z.object({
  id: z.string(),
  subject: z.string(),
  description: z.string(),
  status: StoredTaskStatusSchema,
  owner: z.string().optional(),
  activeForm: z.string().optional(),
  blocks: z.array(z.string()),
  blockedBy: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()),
});

export type StoredTask = z.infer<typeof StoredTaskSchema>;

export class TaskStore {
  private filePath: string;

  // Session-scoped store: .yukino/tasks/<listId>.json.
  constructor(workDir: string, listId: string) {
    this.filePath = join(workDir, ".yukino", "tasks", `${listId}.json`);
  }

  load(): StoredTask[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    try {
      const data = readFileSync(this.filePath, "utf-8");
      const raw: unknown = JSON.parse(data);
      const parsed = parse(z.array(StoredTaskSchema), raw);
      return parsed;
    } catch (err) {
      log.error({ err }, "todo operation failed");
      return [];
    }
  }

  save(tasks: StoredTask[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(tasks, null, 2), "utf-8");
  }
}
