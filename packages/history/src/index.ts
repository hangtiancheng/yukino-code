import { randomUUID } from "node:crypto";
import {
  existsSync,
  renameSync,
  rmSync,
  statSync,
  ftruncateSync,
  closeSync,
} from "node:fs";
import { isAbsolute } from "node:path";

import { createChildLogger } from "@yukino.js/logger";
import { getYukinoDir, projectKey, yukinoPath } from "@yukino.js/storage";
import {
  mkdirPrivateSync,
  readPrivateFileSync,
  writePrivateFileSync,
  appendPrivateFileSync,
  openPrivateFileSync,
} from "@yukino.js/storage/private.js";
import { withFileSyncLock } from "@yukino.js/teams/file-lock.js";
import { canonicalPath } from "@yukino.js/utils/paths.js";
import { z } from "zod";

import {
  ACTIVITY_FILE_NAME,
  COMPACT_AFTER_RECORDS,
  MAX_HISTORY_ENTRIES,
  INVALID_PROJECT_MESSAGE,
} from "./constants.js";

export * from "./constants.js";

const TimestampSchema = z.number().int().nonnegative();
export const UserInputSchema = z.object({
  id: z.uuid(),
  timestamp: TimestampSchema,
});
export type UserInput = z.infer<typeof UserInputSchema>;
const ProjectInfoSchema = z.strictObject({
  projectKey: z.string().regex(/^[a-f0-9]{64}$/u),
  cwd: z.string().refine(isAbsolute),
  createdAt: TimestampSchema,
});
export type ProjectInfo = z.infer<typeof ProjectInfoSchema>;
const InputEntrySchema = z.strictObject({
  type: z.literal("input"),
  id: z.uuid(),
  timestamp: TimestampSchema,
  cwd: z.string().refine(isAbsolute),
  sessionId: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/u)
    .nullable(),
  source: z.enum(["cli", "ws", "acp", "print", "sdk"]),
  text: z.string().min(1),
  commandName: z.string().min(1).nullable(),
});
export type InputEntry = z.infer<typeof InputEntrySchema>;
export type InputOptions = Pick<
  InputEntry,
  "cwd" | "sessionId" | "source" | "text"
> & { commandName?: string | null };
const CommandUsageSchema = z.strictObject({
  usageCount: z.number().int().nonnegative(),
  lastUsedAt: TimestampSchema,
});
export type CommandUsage = z.infer<typeof CommandUsageSchema>;
const ActivityStateSchema = z.object({
  projects: z.record(z.string(), ProjectInfoSchema),
  inputs: z.array(InputEntrySchema).max(MAX_HISTORY_ENTRIES),
  commandUsage: z.record(z.string(), CommandUsageSchema),
});
type ActivityState = z.infer<typeof ActivityStateSchema>;
const ActivityRecordSchema = z.discriminatedUnion("type", [
  ProjectInfoSchema.extend({ type: z.literal("project") }),
  InputEntrySchema,
  ActivityStateSchema.extend({ type: z.literal("checkpoint") }),
]);
type ActivityRecord = z.infer<typeof ActivityRecordSchema>;
interface LoadedActivity {
  signature: string;
  state: ActivityState;
  recordCount: number;
  completeBytes: number;
}
const log = createChildLogger({ module: "history" });
const cachedActivity = new Map<string, LoadedActivity>();

function emptyState(): ActivityState {
  return { projects: {}, inputs: [], commandUsage: {} };
}
function signature(filePath: string): string {
  const stat = statSync(filePath);
  return `${String(stat.ino)}:${String(stat.size)}:${String(stat.mtimeMs)}:${String(stat.ctimeMs)}`;
}
function applyRecord(
  state: ActivityState,
  record: ActivityRecord,
): ActivityState {
  if (record.type === "checkpoint") {
    const projects: Record<string, ProjectInfo> = {};
    for (const [key, project] of Object.entries(record.projects)) {
      try {
        if (key !== project.projectKey || projectKey(project.cwd) !== key) {
          throw new Error(INVALID_PROJECT_MESSAGE);
        }
        projects[key] = project;
      } catch (err) {
        log.error({ err }, "parse activity project failed");
      }
    }
    return {
      projects,
      inputs: record.inputs,
      commandUsage: { ...record.commandUsage },
    };
  }
  if (record.type === "project") {
    if (projectKey(record.cwd) !== record.projectKey) {
      throw new Error(INVALID_PROJECT_MESSAGE);
    }
    const { type: _type, ...project } = record;
    state.projects[record.projectKey] ??= project;
    return state;
  }
  state.inputs.push(record);
  if (state.inputs.length > MAX_HISTORY_ENTRIES) {
    state.inputs.splice(0, state.inputs.length - MAX_HISTORY_ENTRIES);
  }
  if (record.commandName !== null) {
    const entry = Object.hasOwn(state.commandUsage, record.commandName)
      ? state.commandUsage[record.commandName]
      : undefined;
    state.commandUsage = {
      ...state.commandUsage,
      [record.commandName]: {
        usageCount: (entry?.usageCount ?? 0) + 1,
        lastUsedAt: Math.max(entry?.lastUsedAt ?? 0, record.timestamp),
      },
    };
  }
  return state;
}
function readActivity(filePath: string): LoadedActivity {
  if (!existsSync(filePath)) {
    return {
      signature: "",
      state: emptyState(),
      recordCount: 0,
      completeBytes: 0,
    };
  }
  const currentSignature = signature(filePath);
  const cached = cachedActivity.get(filePath);
  if (cached?.signature === currentSignature) {
    return cached;
  }
  const content = readPrivateFileSync(filePath);
  const completeBytes = content.lastIndexOf(10) + 1;
  let state = emptyState();
  let recordCount = 0;
  for (const line of content
    .subarray(0, completeBytes)
    .toString("utf8")
    .split("\n")) {
    if (!line.trim()) {
      continue;
    }
    recordCount++;
    try {
      const raw: unknown = JSON.parse(line);
      state = applyRecord(state, ActivityRecordSchema.parse(raw));
    } catch (err) {
      log.error({ err }, "parse activity record failed");
    }
  }
  const loaded = {
    signature: signature(filePath),
    state,
    recordCount,
    completeBytes,
  };
  cachedActivity.set(filePath, loaded);
  return loaded;
}
function writeCheckpoint(filePath: string, loaded: LoadedActivity): void {
  const tempPath = `${filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    writePrivateFileSync(
      tempPath,
      JSON.stringify({ type: "checkpoint", ...loaded.state }) + "\n",
      "utf8",
    );
    renameSync(tempPath, filePath);
    loaded.recordCount = 1;
    loaded.completeBytes = statSync(filePath).size;
  } finally {
    rmSync(tempPath, { force: true });
  }
}
function updateActivity(
  buildRecords: (state: ActivityState) => ActivityRecord[],
  compact = false,
): void {
  mkdirPrivateSync(getYukinoDir());
  const filePath = yukinoPath(ACTIVITY_FILE_NAME);
  withFileSyncLock(filePath, () => {
    try {
      const loaded = readActivity(filePath);
      const records = buildRecords(loaded.state);
      if (
        existsSync(filePath) &&
        statSync(filePath).size !== loaded.completeBytes
      ) {
        const fd = openPrivateFileSync(filePath, "a");
        try {
          ftruncateSync(fd, loaded.completeBytes);
        } finally {
          closeSync(fd);
        }
      }
      if (records.length > 0) {
        const content = records
          .map((record) => JSON.stringify(record) + "\n")
          .join("");
        appendPrivateFileSync(filePath, content);
        for (const record of records) {
          loaded.state = applyRecord(loaded.state, record);
        }
        loaded.recordCount += records.length;
        loaded.completeBytes += Buffer.byteLength(content);
      }
      if (compact || loaded.recordCount >= COMPACT_AFTER_RECORDS) {
        try {
          writeCheckpoint(filePath, loaded);
        } catch (err) {
          if (records.length === 0) {
            throw err;
          }
          log.error({ err }, "compact activity failed");
        }
      }
      if (existsSync(filePath)) {
        loaded.signature = signature(filePath);
        cachedActivity.set(filePath, loaded);
      }
    } catch (error) {
      cachedActivity.delete(filePath);
      throw error;
    }
  });
}
function projectRecords(cwd: string, state: ActivityState): ActivityRecord[] {
  const key = projectKey(cwd);
  return state.projects[key]
    ? []
    : [{ type: "project", cwd, projectKey: key, createdAt: Date.now() }];
}
export function registerProject(cwd: string): void {
  const canonical = canonicalPath(cwd);
  updateActivity((state) => projectRecords(canonical, state));
}
export function recordInput(options: InputOptions): InputEntry {
  const input = InputEntrySchema.parse({
    ...options,
    type: "input",
    id: randomUUID(),
    timestamp: Date.now(),
    cwd: canonicalPath(options.cwd),
    commandName: options.commandName ?? null,
  });
  updateActivity((state) => [...projectRecords(input.cwd, state), input]);
  return { ...input };
}
function query<T>(read: (state: ActivityState) => T): T {
  const filePath = yukinoPath(ACTIVITY_FILE_NAME);
  if (!existsSync(filePath)) {
    return read(emptyState());
  }
  return withFileSyncLock(filePath, () => read(readActivity(filePath).state));
}
export function loadInputs(): InputEntry[] {
  return query((state) => state.inputs.map((input) => ({ ...input })));
}
export function loadInputTexts(): string[] {
  return loadInputs()
    .map((input) => input.text)
    .filter((text, index, texts) => index === 0 || text !== texts[index - 1]);
}
export function getCommandUsage(): Record<string, CommandUsage> {
  return query((state) =>
    Object.fromEntries(
      Object.entries(state.commandUsage).map(([name, usage]) => [
        name,
        { ...usage },
      ]),
    ),
  );
}
export function listProjects(): ProjectInfo[] {
  return query((state) =>
    Object.values(state.projects)
      .map((project) => ({ ...project }))
      .sort((a, b) => a.projectKey.localeCompare(b.projectKey)),
  );
}
export function compactActivity(): void {
  updateActivity(() => [], true);
}
