import { randomUUID } from "node:crypto";
import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import z, { parse } from "zod";

import { createChildLogger } from "@/logger/index.js";
import { sessionPath } from "@/storage/index.js";
import {
  mkdirPrivateSync as mkdirSync,
  readPrivateFileSync as readFileSync,
  writePrivateFileSync as writeFileSync,
} from "@/storage/private.js";
import { PRIVATE_BOARD_ID_PREFIX, TASKS_FILENAME } from "@/todo/constants.js";

const log = createChildLogger({ module: "todo" });

export const StoredTaskStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "blocked",
  "cancelled",
]);

export type StoredTaskStatus = z.infer<typeof StoredTaskStatusSchema>;

const TaskIdSchema = z.string().regex(/^[1-9]\d*$/u);

export const StoredTaskSchema = z.object({
  id: TaskIdSchema,
  subject: z.string().trim().min(1),
  description: z.string(),
  status: StoredTaskStatusSchema,
  owner: z.string().optional(),
  blocks: z.array(TaskIdSchema),
  blockedBy: z.array(TaskIdSchema),
  metadata: z.record(z.string(), z.unknown()),
  priority: z.enum(["high", "medium", "low"]).optional(),
});

export type StoredTask = z.infer<typeof StoredTaskSchema>;

export const TaskSnapshotSchema = z.object({
  nextId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  tasks: z.array(StoredTaskSchema),
});

export class TaskStore {
  private filePath: string;
  readonly boardId: string;

  constructor(listId: string) {
    if (!/^[A-Za-z0-9_-]+$/u.test(listId)) {
      throw new Error("Invalid task list ID");
    }
    this.filePath = sessionPath(listId, TASKS_FILENAME);
    this.boardId = `${PRIVATE_BOARD_ID_PREFIX}${listId}`;
  }

  load(): z.infer<typeof TaskSnapshotSchema> {
    if (!existsSync(this.filePath)) {
      return { nextId: 1, tasks: [] };
    }
    try {
      const data = readFileSync(this.filePath, "utf-8");
      const raw: unknown = JSON.parse(data);
      const parsed = parse(TaskSnapshotSchema, raw);
      if (parsed.tasks.some((task) => Number(task.id) >= parsed.nextId)) {
        throw new Error("Invalid task ID counter");
      }
      return parsed;
    } catch (err) {
      log.error({ err }, "todo operation failed");
      throw new Error("Cannot load an unreadable task list", { cause: err });
    }
  }

  save(tasks: StoredTask[], nextId: number): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        tempPath,
        JSON.stringify({ nextId, tasks }, null, 2),
        "utf-8",
      );
      renameSync(tempPath, this.filePath);
    } finally {
      rmSync(tempPath, { force: true });
    }
  }
}
