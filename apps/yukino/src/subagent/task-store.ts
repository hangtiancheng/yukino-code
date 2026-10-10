import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { sessionPath } from "@/storage/paths.js";

const TaskId = z.string().regex(/^[\w-]+-[1-9]\d*$/u);
const TaskRecord = z.object({
  id: TaskId,
  name: z.string(),
  kind: z.enum(["agent", "shell"]).optional(),
  originToolCallId: z.string().optional(),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  output: z.string(),
  error: z.string().optional(),
  transcriptPath: z.string().optional(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  notified: z.boolean(),
});

export type StoredBackgroundTask = z.infer<typeof TaskRecord>;

export class BackgroundTaskStore {
  private directory: string;

  constructor(sessionId: string) {
    this.directory = sessionPath(sessionId, "background-tasks");
  }

  get(id: string): StoredBackgroundTask | undefined {
    if (!TaskId.safeParse(id).success) {
      return undefined;
    }
    const path = join(this.directory, `${id}.json`);
    if (!existsSync(path)) {
      return undefined;
    }
    const record = TaskRecord.parse(JSON.parse(readFileSync(path, "utf8")));
    if (record.id !== id) {
      throw new Error(`Background task ID does not match its file: ${id}`);
    }
    return record;
  }

  load(): StoredBackgroundTask[] {
    if (!existsSync(this.directory)) {
      return [];
    }
    return readdirSync(this.directory)
      .filter((file) => file.endsWith(".json"))
      .map((file) => this.get(file.slice(0, -5)))
      .filter((record): record is StoredBackgroundTask => record !== undefined)
      .sort(
        (a, b) =>
          a.startedAt - b.startedAt ||
          Number(a.id.split("-").at(-1)) - Number(b.id.split("-").at(-1)),
      );
  }

  save(record: StoredBackgroundTask): void {
    TaskRecord.parse(record);
    mkdirSync(this.directory, { recursive: true });
    const path = join(this.directory, `${record.id}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(record), "utf8");
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
