import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { sessionPath } from "@/storage/index.js";
import { writePrivateFileAtomicallySync } from "@/storage/private.js";
import {
  mkdirPrivateSync as mkdirSync,
  readPrivateFileSync as readFileSync,
} from "@/storage/private.js";
import {
  BACKGROUND_TASKS_DIR_NAME,
  TASK_RECORD_EXTENSION,
} from "@/subagent/constants.js";

const TaskId = z.string().regex(/^[\w-]+-[1-9]\d*$/u);
const TaskRecord = z.object({
  id: TaskId,
  name: z.string(),
  kind: z.enum(["agent", "shell", "workflow"]).optional(),
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
    this.directory = sessionPath(sessionId, BACKGROUND_TASKS_DIR_NAME);
  }

  get(id: string): StoredBackgroundTask | undefined {
    if (!TaskId.safeParse(id).success) {
      return undefined;
    }
    const path = join(this.directory, `${id}${TASK_RECORD_EXTENSION}`);
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
      .filter((file) => file.endsWith(TASK_RECORD_EXTENSION))
      .map((file) => this.get(file.slice(0, -TASK_RECORD_EXTENSION.length)))
      .filter((record): record is StoredBackgroundTask => record !== undefined)
      .sort(
        (a, b) =>
          a.startedAt - b.startedAt ||
          Number(a.id.split("-").at(-1)) - Number(b.id.split("-").at(-1)),
      );
  }

  save(record: StoredBackgroundTask): void {
    TaskRecord.parse(record);
    mkdirSync(this.directory);
    const path = join(this.directory, `${record.id}${TASK_RECORD_EXTENSION}`);
    writePrivateFileAtomicallySync(path, JSON.stringify(record));
  }
}
