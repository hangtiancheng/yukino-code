import { readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { projectPath } from "@yukino.js/storage";
import { writePrivateFile } from "@yukino.js/storage/private.js";
import { asRecord } from "@yukino.js/utils";
import {
  REQUEST_FILENAME,
  RUN_ID_RE,
  SCRIPT_FILENAME,
  STATE_FILENAME,
  WORKFLOW_RUNS_DIR,
} from "./constants.js";
import { workflowRunSchema, type WorkflowRun } from "./progress.js";

export const savedWorkflowSchema = z.object({
  workflowName: z.string(),
  args: z.json().optional(),
  maxConcurrency: z.number().int().positive().optional(),
});
export type SavedWorkflow = z.infer<typeof savedWorkflowSchema>;

export class WorkflowPersistence {
  readonly directory: string;
  constructor(cwd: string) {
    this.directory = projectPath(cwd, WORKFLOW_RUNS_DIR);
  }
  path(runId: string, filename: string): string {
    if (!RUN_ID_RE.test(runId)) {
      throw new Error("Invalid workflow run ID");
    }
    return join(this.directory, runId, filename);
  }
  async saveRequest(
    runId: string,
    script: string,
    request: SavedWorkflow,
  ): Promise<string> {
    const path = this.path(runId, SCRIPT_FILENAME);
    await writePrivateFile(path, script);
    await writePrivateFile(
      this.path(runId, REQUEST_FILENAME),
      JSON.stringify(request),
    );
    return path;
  }
  async readRequest(runId: string): Promise<SavedWorkflow> {
    return savedWorkflowSchema.parse(
      JSON.parse(await readFile(this.path(runId, REQUEST_FILENAME), "utf8")),
    );
  }
  async writeState(run: WorkflowRun): Promise<void> {
    const path = this.path(run.runId, STATE_FILENAME);
    await writePrivateFile(path + ".tmp", JSON.stringify(run));
    await rename(path + ".tmp", path);
  }
  async list(): Promise<WorkflowRun[]> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      if (asRecord(error).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const runs = await Promise.all(
      entries
        .filter((id) => RUN_ID_RE.test(id))
        .map(async (id) => {
          try {
            return workflowRunSchema.parse(
              JSON.parse(await readFile(this.path(id, STATE_FILENAME), "utf8")),
            );
          } catch {
            return null;
          }
        }),
    );
    return runs
      .filter((run): run is WorkflowRun => run !== null)
      .sort((a, b) => b.startedAt - a.startedAt);
  }
}
