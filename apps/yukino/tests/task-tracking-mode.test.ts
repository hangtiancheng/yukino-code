import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createToolRegistry } from "@yukino.js/bootstrap/tool-registry.js";
import { buildToolGuidance } from "@yukino.js/prompt/tools.js";
import { sessionPath } from "@yukino.js/storage";
import {
  cloneRegistryForTeammate,
  filterToolsForAgent,
} from "@yukino.js/subagent/tool-filter.js";
import { TeamManager } from "@yukino.js/teams";
import { SharedTaskStore } from "@yukino.js/teams/shared-task.js";
import { teamDir } from "@yukino.js/teams/team-file.js";
import { TaskList } from "@yukino.js/todo";
import { StoredTaskSchema, TaskStore } from "@yukino.js/todo/store.js";
import type { ToolRegistry } from "@yukino.js/tools/registry.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import z from "zod";

function snapshot(output: string) {
  return z
    .object({
      boardId: z.string(),
      todos: z.array(StoredTaskSchema),
      progress: z.string(),
    })
    .parse(JSON.parse(output));
}

let cwd: string;
let manager: TeamManager;
const registries: ToolRegistry[] = [];
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "yukino-tracking-mode-"));
  manager = new TeamManager(cwd);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(registries.splice(0).map((registry) => registry.dispose()));
  await manager.dispose();
  rmSync(cwd, { recursive: true, force: true });
});
function registry(
  interactionMode: "interactive" | "non-interactive" = "interactive",
  list = new TaskList(),
) {
  const result = createToolRegistry(cwd, list, {
    interactionMode,
    teamManager: manager,
  });
  registries.push(result);
  return result;
}
function tool(registry: ToolRegistry) {
  const result = registry.get("TodoWrite");
  if (!result) {
    throw new Error("Missing TodoWrite");
  }
  return result;
}
function fixture(board: string) {
  const store = new TaskStore("tracking");
  const list = new TaskList(store);
  const tools = registry("interactive", list);
  if (board === "shared") {
    manager.create("squad");
  }
  const file =
    board === "shared"
      ? join(teamDir(cwd, "squad"), "tasks.json")
      : sessionPath("tracking", "tasks.json");
  const write = tool(tools);
  const execute = (args: Record<string, unknown>) =>
    write.execute({ cwd }, args);
  return { store, list, tools, write, execute, file };
}

describe("unified TODO tracking", () => {
  it.each(["interactive", "non-interactive"] as const)(
    "keeps one stable tool in %s sessions across team creation and deletion",
    async (mode) => {
      const list = new TaskList();
      const tools = registry(mode, list);
      const write = tool(tools);
      const schema = write.schema();
      const names = () =>
        tools
          .getAllSchemas()
          .map((schema) => schema.name)
          .filter((name) =>
            /^(TodoWrite|TaskCreate|TaskGet|TaskList|TaskUpdate)$/u.test(name),
          );
      expect(names()).toEqual(["TodoWrite"]);
      await write.execute({ cwd }, { todos: [{ subject: "private" }] });
      manager.create("squad");
      expect(tool(tools)).toBe(write);
      expect(write.schema()).toEqual(schema);
      expect(names()).toEqual(["TodoWrite"]);
      const shared = await write.execute(
        { cwd },
        { todos: [{ subject: "shared" }] },
      );
      expect(snapshot(shared.output)).toMatchObject({
        boardId: "team:squad",
        todos: [{ id: "1", subject: "shared" }],
      });
      expect(list.list().map((task) => task.subject)).toEqual(["private"]);
      await manager.delete("squad");
      expect(tool(tools)).toBe(write);
      expect(snapshot((await write.execute({ cwd }, {})).output)).toMatchObject(
        {
          boardId: list.boardId,
          todos: [{ subject: "private" }],
        },
      );
      const guidance = buildToolGuidance(
        tools.getAllSchemas().map((schema) => schema.name),
      );
      expect(guidance).toContain("incrementally");
      expect(guidance).not.toMatch(
        /TaskCreate|TaskGet|TaskList|TaskUpdate|replaces the entire/u,
      );
    },
  );

  it.each(["private", "shared"])(
    "initializes every field, merges metadata and persists the %s board",
    async (board) => {
      const { execute, file } = fixture(board);
      const created = await execute({
        todos: [
          {
            subject: "first",
            description: "details",
            priority: "high",
            owner: "leader",
            status: "blocked",
            metadata: { keep: 1, remove: true, nested: { before: true } },
          },
        ],
      });
      expect(created.isError).toBe(false);
      expect(snapshot(created.output)).toMatchObject({
        progress: "TODO 0/1",
        todos: [
          { id: "1", status: "blocked", priority: "high", owner: "leader" },
        ],
      });
      const updated = await execute({
        todos: [
          {
            id: "1",
            status: "completed",
            metadata: {
              remove: null,
              added: [null, 2],
              nested: { after: true },
            },
          },
          { subject: "second", priority: "low", blockedBy: ["1"] },
        ],
      });
      expect(updated.isError).toBe(false);
      const expected = { keep: 1, added: [null, 2], nested: { after: true } };
      expect(snapshot(updated.output)).toMatchObject({
        progress: "TODO 1/2",
        todos: [
          {
            id: "1",
            description: "details",
            priority: "high",
            metadata: expected,
            blocks: ["2"],
          },
          { id: "2", priority: "low", status: "pending", blockedBy: ["1"] },
        ],
      });
      const restored =
        board === "shared"
          ? new SharedTaskStore(file).get("1")
          : new TaskList(new TaskStore("tracking")).get("1");
      expect(restored?.metadata).toEqual(expected);
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
        nextId: 3,
        tasks: [{ id: "1", metadata: expected }, { id: "2" }],
      });
    },
  );

  it.each(["private", "shared"])(
    "creates five prioritized items concurrently on the %s board",
    async (board) => {
      const { execute } = fixture(board);
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          execute({ todos: [{ subject: `Task ${i}`, priority: "high" }] }),
        ),
      );
      expect(results.every((result) => !result.isError)).toBe(true);
      const { todos } = snapshot((await execute({})).output);
      expect(todos).toHaveLength(5);
      expect(new Set(todos.map((task) => task.id)).size).toBe(5);
      expect(todos.every((task) => task.priority === "high")).toBe(true);
    },
  );

  it.each(["private", "shared"])(
    "refreshes the %s board without saving or notifying, and treats empty arrays as no-ops",
    async (board) => {
      const { execute, store, file, list } = fixture(board);
      await execute({ todos: [{ subject: "original" }] });
      const changed = vi.fn();
      const unsubscribe =
        board === "shared"
          ? manager.getTaskStore("squad").subscribe(changed)
          : list.subscribe(changed);
      changed.mockClear();
      const save = vi.spyOn(store, "save");
      const before = readFileSync(file, "utf8");
      const mtime = statSync(file).mtimeMs;
      for (const args of [{}, { todos: [] }, { deleteIds: [] }]) {
        const result = await execute(args);
        expect(result.isError).toBe(false);
        expect(snapshot(result.output).todos).toHaveLength(1);
      }
      expect(save).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
      expect(readFileSync(file, "utf8")).toBe(before);
      expect(statSync(file).mtimeMs).toBe(mtime);
      unsubscribe();
    },
  );

  it.each(["private", "shared"])(
    "rejects malformed, unknown and conflicting edits atomically on the %s board",
    async (board) => {
      const { execute, file } = fixture(board);
      await execute({ todos: [{ subject: "original" }] });
      const before = readFileSync(file, "utf8");
      const invalid = [
        { unknownField: true },
        { todos: [{ subject: "x", unknownField: true }] },
        { todos: [{}] },
        { todos: [{ id: "999", subject: "x" }] },
        { todos: [{ id: "1", status: "deleted" }] },
        { todos: [{ id: "1", priority: "urgent" }] },
        { todos: [{ id: "1", metadata: null }] },
        { todos: [{ id: "1" }, { id: "1" }] },
        { todos: [{ id: "1" }], deleteIds: ["1"] },
        { deleteIds: ["1", "1"] },
        { deleteIds: ["999"] },
        { todos: [{ subject: "valid" }, { subject: "bad", blockedBy: ["2"] }] },
        ...[1, "", "0", "01", "-1", "1.0", " 1 ", "1\n", "task-1"].flatMap(
          (id) => [
            { todos: [{ id, status: "completed" }] },
            { deleteIds: [id] },
            ...["blocks", "blockedBy"].map((field) => ({
              todos: [{ id: "1", [field]: [id] }],
            })),
          ],
        ),
      ];
      for (const args of invalid) {
        expect((await execute(args)).isError).toBe(true);
        expect(readFileSync(file, "utf8")).toBe(before);
      }
      const next = await execute({ todos: [{ subject: "next" }] });
      expect(snapshot(next.output).todos[1].id).toBe("2");
    },
  );

  it.each(["subagent", "background", "fork", "teammate"])(
    "gives %s registry clones isolated private boards",
    async (kind) => {
      const parent = registry();
      manager.create("squad");
      await tool(parent).execute({ cwd }, { todos: [{ subject: "shared" }] });
      const clone = () =>
        kind === "teammate"
          ? cloneRegistryForTeammate(parent)
          : filterToolsForAgent(
              parent,
              undefined,
              undefined,
              kind === "background",
            );
      const child = clone();
      const sibling = clone();
      registries.push(child, sibling);
      await tool(child).execute({ cwd }, { todos: [{ subject: "child" }] });
      expect(
        snapshot((await tool(child).execute({ cwd }, {})).output).todos,
      ).toMatchObject([{ subject: "child" }]);
      expect(
        snapshot((await tool(sibling).execute({ cwd }, {})).output).todos,
      ).toEqual([]);
      expect(
        manager
          .getTaskStore("squad")
          .listTasks()
          .map((task) => task.subject),
      ).toEqual(["shared"]);
    },
  );
});
