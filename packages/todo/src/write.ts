import z from "zod";

import {
  MAX_TODO_WRITE_ITEMS,
  NEW_TODO_SUBJECT_REQUIRED,
} from "./constants.js";
import {
  unresolvedTaskDependencies,
  validateTaskDependencies,
} from "./dependencies.js";
import { TODO_FIELD_DESCRIPTIONS } from "./prompts.js";
import { StoredTaskSchema, type StoredTask } from "./store.js";

export const TodoInputSchema = z
  .strictObject({
    id: StoredTaskSchema.shape.id
      .optional()
      .describe(TODO_FIELD_DESCRIPTIONS.id),
    subject: StoredTaskSchema.shape.subject
      .optional()
      .describe(TODO_FIELD_DESCRIPTIONS.subject),
    description: StoredTaskSchema.shape.description
      .optional()
      .describe(TODO_FIELD_DESCRIPTIONS.description),
    status: StoredTaskSchema.shape.status
      .optional()
      .describe(TODO_FIELD_DESCRIPTIONS.status),
    owner: StoredTaskSchema.shape.owner.describe(TODO_FIELD_DESCRIPTIONS.owner),
    priority: StoredTaskSchema.shape.priority.describe(
      TODO_FIELD_DESCRIPTIONS.priority,
    ),
    metadata: StoredTaskSchema.shape.metadata
      .optional()
      .describe(TODO_FIELD_DESCRIPTIONS.metadata),
    blocks: StoredTaskSchema.shape.blocks
      .optional()
      .describe(TODO_FIELD_DESCRIPTIONS.blocks),
    blockedBy: StoredTaskSchema.shape.blockedBy
      .optional()
      .describe(TODO_FIELD_DESCRIPTIONS.blockedBy),
  })
  .refine((item) => item.id !== undefined || item.subject !== undefined, {
    message: NEW_TODO_SUBJECT_REQUIRED,
    path: ["subject"],
  });

export const TodoWriteSchema = z.strictObject({
  todos: z.array(TodoInputSchema).max(MAX_TODO_WRITE_ITEMS).optional(),
  deleteIds: z
    .array(StoredTaskSchema.shape.id)
    .max(MAX_TODO_WRITE_ITEMS)
    .optional()
    .describe(TODO_FIELD_DESCRIPTIONS.deleteIds),
});

export type TodoInput = z.infer<typeof TodoInputSchema>;
export type TodoWriteInput = z.infer<typeof TodoWriteSchema>;

export interface TodoWriteOptions<T extends StoredTask> {
  createTask: (task: StoredTask) => T;
  actor?: string;
  validateOwner?: (owner: string) => void;
}

function mergeTaskMetadata(
  current: Record<string, unknown>,
  updates: Record<string, unknown> = {},
): Record<string, unknown> {
  const entries = new Map(Object.entries(current));
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) {
      entries.delete(key);
    } else {
      entries.set(key, value);
    }
  }
  return structuredClone(Object.fromEntries(entries));
}

export function applyTodoWrite<T extends StoredTask>(
  current: readonly T[],
  nextId: number,
  input: TodoWriteInput,
  options: TodoWriteOptions<T>,
): { tasks: T[]; nextId: number } {
  const { todos = [], deleteIds = [] } = TodoWriteSchema.parse(input);
  const original = new Map(current.map((task) => [task.id, task]));
  const tasks = new Map(
    structuredClone(current).map((task) => [task.id, task]),
  );
  const getTask = (id: string): T => {
    const task = tasks.get(id);
    if (!task) {
      throw new Error(`Task #${id} not found`);
    }
    return task;
  };
  const edits = new Map<string, TodoInput>();
  const deleted = new Set(deleteIds);
  if (deleted.size !== deleteIds.length) {
    throw new Error("Duplicate task IDs in deleteIds");
  }
  const assertOwner = (task: T): void => {
    if (options.actor && task.owner && task.owner !== options.actor) {
      throw new Error(`Task #${task.id} is already claimed by '${task.owner}'`);
    }
  };
  for (const id of deleteIds) {
    const task = tasks.get(id);
    if (!task) {
      throw new Error(`Task #${id} not found`);
    }
    assertOwner(task);
    tasks.delete(id);
  }
  for (const task of tasks.values()) {
    task.blocks = task.blocks.filter((id) => !deleted.has(id));
    task.blockedBy = task.blockedBy.filter((id) => !deleted.has(id));
  }
  for (const todo of todos) {
    const {
      id: suppliedId,
      blocks: _blocks,
      blockedBy: _blockedBy,
      metadata,
      ...fields
    } = todo;
    const previous =
      suppliedId === undefined ? undefined : original.get(suppliedId);
    if (suppliedId !== undefined && !previous) {
      throw new Error(`Task #${suppliedId} not found`);
    }
    const id = suppliedId ?? String(nextId++);
    if (edits.has(id) || deleted.has(id)) {
      throw new Error(`Duplicate task ID: ${id}`);
    }
    edits.set(id, todo);
    if (previous) {
      assertOwner(previous);
    }
    if (fields.owner) {
      if (options.actor && fields.owner !== options.actor) {
        throw new Error("Only the leader can assign tasks to other teammates");
      }
      options.validateOwner?.(fields.owner);
    }
    const task = previous
      ? getTask(id)
      : options.createTask({
          id,
          subject: "",
          description: "",
          status: "pending",
          owner: "",
          metadata: {},
          blocks: [],
          blockedBy: [],
        });
    if (options.actor && fields.status === "in_progress") {
      if (
        previous?.status === "completed" ||
        previous?.status === "cancelled"
      ) {
        throw new Error(
          `Task #${id} is already ${previous.status}; reopen it as pending first`,
        );
      }
      task.owner = options.actor;
    }
    Object.assign(
      task,
      structuredClone(
        Object.fromEntries(
          Object.entries(fields).filter(([, value]) => value !== undefined),
        ),
      ),
    );
    task.metadata = mergeTaskMetadata(task.metadata, metadata);
    Object.assign(task, StoredTaskSchema.parse(task));
    tasks.set(id, task);
  }
  for (const [id, edit] of edits) {
    const task = getTask(id);
    if (edit.blocks !== undefined) {
      for (const otherId of task.blocks) {
        const other = getTask(otherId);
        other.blockedBy = other.blockedBy.filter((value) => value !== id);
      }
      task.blocks = [];
    }
    if (edit.blockedBy !== undefined) {
      for (const otherId of task.blockedBy) {
        const other = getTask(otherId);
        other.blocks = other.blocks.filter((value) => value !== id);
      }
      task.blockedBy = [];
    }
  }
  const link = (from: string, to: string): void => {
    if (from === to) {
      throw new Error(`Task #${from} cannot depend on itself`);
    }
    const blocker = tasks.get(from);
    const blocked = tasks.get(to);
    if (!blocker || !blocked) {
      throw new Error(`Unknown dependency: #${from} → #${to}`);
    }
    if (!blocker.blocks.includes(to)) {
      blocker.blocks.push(to);
    }
    if (!blocked.blockedBy.includes(from)) {
      blocked.blockedBy.push(from);
    }
  };
  for (const [id, edit] of edits) {
    for (const [field, references] of [
      ["blocks", edit.blocks],
      ["blockedBy", edit.blockedBy],
    ] as const) {
      for (const otherId of references ?? []) {
        if (
          otherId !== id &&
          (!original.has(otherId) || deleted.has(otherId))
        ) {
          throw new Error(
            `Unknown dependency: task #${otherId} does not exist before this call`,
          );
        }
        if (field === "blocks") {
          link(id, otherId);
        } else {
          link(otherId, id);
        }
      }
    }
  }
  for (const [id, edit] of edits) {
    const task = getTask(id);
    for (const field of ["blocks", "blockedBy"] as const) {
      const requested = edit[field];
      if (
        requested &&
        (task[field].length !== new Set(requested).size ||
          task[field].some((value) => !requested.includes(value)))
      ) {
        throw new Error(`Conflicting dependency edits for task #${id}`);
      }
    }
  }
  validateTaskDependencies(tasks.values());
  for (const task of tasks.values()) {
    if (task.status !== "in_progress") {
      continue;
    }
    const blockers = unresolvedTaskDependencies(task, tasks.values());
    if (blockers.length) {
      throw new Error(`Task #${task.id} is blocked by: ${blockers.join(", ")}`);
    }
    if (options.actor && edits.has(task.id) && !task.owner) {
      throw new Error("An in-progress teammate task must have an owner");
    }
  }
  if (options.actor) {
    const busy = [...tasks.values()].filter(
      (task) => task.owner === options.actor && task.status === "in_progress",
    );
    if (busy.length > 1) {
      throw new Error(
        `Teammate '${options.actor}' is already working on task #${busy[0].id}`,
      );
    }
  }
  return { tasks: [...tasks.values()], nextId };
}
