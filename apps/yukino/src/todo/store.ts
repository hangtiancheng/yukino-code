import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

  // Session-scoped store persisted at <workDir>/.yukino/tasks/<listId>.json.
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
    const tempPath = `${this.filePath}.${String(process.pid)}.tmp`;
    try {
      writeFileSync(tempPath, JSON.stringify(tasks, null, 2), "utf-8");
      renameSync(tempPath, this.filePath);
    } finally {
      rmSync(tempPath, { force: true });
    }
  }
}
