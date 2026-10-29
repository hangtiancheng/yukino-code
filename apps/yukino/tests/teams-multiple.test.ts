import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentTool } from "@/subagent/agent-tool.js";
import { TeamManager } from "@/teams/index.js";
import { TaskStopTool } from "@/teams/task-stop.js";
import { subscribeLeaderTasks, TeamTodoWriteTool } from "@/teams/task-tools.js";
import { listTeamNames } from "@/teams/team-file.js";
import {
  TeamCreateTool,
  TeamDeleteTool,
  TeamListTool,
  SendMessageTool,
} from "@/teams/tools.js";
import { TaskList, type Task } from "@/todo/index.js";
import { ToolRegistry } from "@/tools/registry.js";

vi.mock("node:os", async (original) => ({
  ...(await original<typeof os>()),
  homedir: vi.fn(),
}));

let cwd: string;
let manager: TeamManager;
beforeEach(() => {
  cwd = mkdtempSync(join(os.tmpdir(), "yukino-multiple-teams-"));
  vi.mocked(os.homedir).mockReturnValue(cwd);
  manager = new TeamManager(cwd);
});
afterEach(async () => {
  await manager.dispose();
  vi.restoreAllMocks();
  rmSync(cwd, { recursive: true, force: true });
});

describe("multiple teams", () => {
  it("creates concurrent teams and lists all of them", async () => {
    const create = new TeamCreateTool(manager);
    const results = await Promise.all(
      [1, 2, 3].map(() => create.execute({ cwd }, {})),
    );
    expect(results.every((result) => !result.isError)).toBe(true);
    expect(new Set(manager.list().map((team) => team.name)).size).toBe(3);
    expect(listTeamNames(cwd)).toHaveLength(3);
    const listing = await new TeamListTool(manager).execute();
    for (const team of manager.list()) {
      expect(listing.output).toContain(team.name);
    }
  });

  it("routes spawning and same-name teammates' messages and tasks to their selected teams", async () => {
    const first = manager.create("first");
    const second = manager.create("second");
    const registries = new Map<string, ToolRegistry>();
    const agent = new AgentTool(cwd, new ToolRegistry(), () =>
      Promise.resolve("unused"),
    );
    agent.setTeamManager(manager, (registry) => {
      registries.set(registries.size ? "second" : "first", registry);
      return () => Promise.resolve("done");
    });
    for (const team of [first, second]) {
      const result = await agent.execute(
        { cwd },
        {
          description: "reviewer",
          prompt: "review",
          fork: false,
          team_name: team.name,
        },
      );
      expect(result.isError).toBe(false);
      expect(result.output).toContain(`team '${team.name}'`);
    }
    await vi.waitFor(() => {
      expect(first.getMember("reviewer")?.uiState?.status).toBe("idle");
      expect(second.getMember("reviewer")?.uiState?.status).toBe("idle");
    });
    manager.drainLeaderMailbox();

    const secondTools = registries.get("second");
    assert(secondTools);
    expect(
      (
        await secondTools
          .get("SendMessage")
          ?.execute({ cwd }, { to: "leader", content: "second report" })
      )?.isError,
    ).toBe(false);
    expect(first.leaderMailbox.receiveSync()).toEqual([]);
    expect(second.leaderMailbox.receiveSync()).toMatchObject([
      { from: "reviewer", text: "second report" },
    ]);
    expect(
      (
        await secondTools
          .get("SendMessage")
          ?.execute(
            { cwd },
            { team_name: "first", to: "leader", content: "wrong team" },
          )
      )?.isError,
    ).toBe(true);

    const todo = new TeamTodoWriteTool(manager);
    for (const team of [first, second]) {
      expect(
        (
          await todo.execute(
            { cwd },
            { team_name: team.name, todos: [{ subject: `${team.name} work` }] },
          )
        )?.isError,
      ).toBe(false);
    }
    expect(
      (
        await secondTools
          .get("TodoWrite")
          ?.execute({ cwd }, { todos: [{ id: "1", status: "in_progress" }] })
      )?.isError,
    ).toBe(false);
    expect(manager.getTaskStore("second").get("1")).toMatchObject({
      owner: "reviewer",
      status: "in_progress",
    });
    expect(manager.getTaskStore("first").get("1")).toMatchObject({
      owner: "",
      status: "pending",
    });
    expect(
      (
        await secondTools
          .get("TodoWrite")
          ?.execute({ cwd }, { team_name: "first", deleteIds: ["1"] })
      )?.isError,
    ).toBe(true);
    expect(manager.getTaskStore("first").listTasks()).toHaveLength(1);

    const stop = new TaskStopTool(manager);
    expect(
      (await stop.execute({ cwd }, { teammate: "reviewer" }))?.isError,
    ).toBe(true);
    expect(first.getMember("reviewer")?.active).toBe(true);
    expect(second.getMember("reviewer")?.active).toBe(true);
    expect(
      (
        await stop.execute(
          { cwd },
          { teammate: "reviewer", team_name: "second" },
        )
      )?.isError,
    ).toBe(false);
    expect(first.getMember("reviewer")?.active).toBe(true);
    expect(second.getMember("reviewer")?.active).toBe(false);
    expect(manager.getTaskStore("second").get("1")).toMatchObject({
      owner: "",
      status: "pending",
    });
  });

  it("routes text, broadcasts, and structured controls only to the selected team", async () => {
    const first = manager.create("first");
    const second = manager.create("second");
    first.addMember("reviewer");
    second.addMember("reviewer");
    const send = new SendMessageTool(manager);
    for (const args of [
      { to: "reviewer", content: "text" },
      { to: "*", content: "broadcast" },
      { to: "reviewer", content: "stop", type: "shutdown_request" },
    ]) {
      expect(
        (await send.execute({ cwd }, { ...args, team_name: "second" }))
          ?.isError,
      ).toBe(false);
    }
    expect(first.getMember("reviewer")?.mailbox.receiveSync()).toEqual([]);
    expect(
      second
        .getMember("reviewer")
        ?.mailbox.receiveSync()
        .map((message) => message.text),
    ).toEqual(["text", "broadcast", "stop"]);
  });

  it("rejects ambiguous or missing team targets without spawning, messaging, editing, or deleting", async () => {
    const first = manager.create("first");
    manager.create("second");
    first.addMember("reviewer");
    const factory = vi.fn(() => () => Promise.resolve("done"));
    const agent = new AgentTool(cwd, new ToolRegistry(), () =>
      Promise.resolve("unused"),
    );
    agent.setTeamManager(manager, factory);
    for (const target of [{}, { team_name: "missing" }]) {
      const results = await Promise.all([
        agent.execute(
          { cwd },
          { ...target, description: "worker", prompt: "work", fork: false },
        ),
        new SendMessageTool(manager).execute(
          { cwd },
          { ...target, to: "reviewer", content: "message" },
        ),
        new TeamTodoWriteTool(manager).execute(
          { cwd },
          { ...target, todos: [{ subject: "work" }] },
        ),
        new TeamDeleteTool(manager).execute({ cwd }, target),
      ]);
      expect(results.every((result) => result.isError)).toBe(true);
    }
    expect(factory).not.toHaveBeenCalled();
    expect(manager.list()).toHaveLength(2);
    expect(first.listMembers().map((member) => member.name)).toEqual([
      "reviewer",
    ]);
    expect(first.getMember("reviewer")?.mailbox.receiveSync()).toEqual([]);
    expect(manager.getTaskStore("first").listTasks()).toEqual([]);
  });

  it("deletes only the selected team and restores all remaining teams with their boards", async () => {
    const first = manager.create("first");
    const second = manager.create("second");
    for (const team of [first, second]) {
      team.spawnTeammate("worker", "work", () => Promise.resolve("done"));
      manager
        .getTaskStore(team.name)
        .write({ todos: [{ subject: team.name }] });
    }
    expect(
      (
        await new TeamDeleteTool(manager).execute(
          { cwd },
          { team_name: "first" },
        )
      )?.isError,
    ).toBe(false);
    expect(first.getMember("worker")?.active).toBe(false);
    expect(second.getMember("worker")?.active).toBe(true);
    expect(manager.list()).toEqual([second]);
    expect(listTeamNames(cwd)).toEqual(["second"]);
    manager.create("third");
    const restored = new TeamManager(cwd);
    restored.restoreFromDisk();
    expect(
      restored
        .list()
        .map((team) => team.name)
        .sort(),
    ).toEqual(["second", "third"]);
    expect(restored.getTaskStore("second").listTasks()[0]?.subject).toBe(
      "second",
    );
    await restored.dispose();
  });

  it("combines task progress across teams with overlapping task IDs and unsubscribes removed boards", async () => {
    manager.create("first");
    manager.create("second");
    const privateList = new TaskList();
    const listener = vi.fn<(tasks: Task[], boardId: string) => void>();
    const unsubscribe = subscribeLeaderTasks(manager, privateList, listener);
    try {
      manager
        .getTaskStore("first")
        .write({ todos: [{ subject: "first", status: "completed" }] });
      manager.getTaskStore("second").write({ todos: [{ subject: "second" }] });
      const tasks = listener.mock.lastCall?.[0] ?? [];
      expect(tasks.map((task) => task.subject)).toEqual([
        "[first] first",
        "[second] second",
      ]);
      expect(new Set(tasks.map((task) => task.id)).size).toBe(2);
      expect(manager.getTaskStore("second").get("1")?.subject).toBe("second");
      await manager.delete("first");
      expect(listener.mock.lastCall?.[0]).toMatchObject([
        { id: "1", subject: "second" },
      ]);
      await manager.delete("second");
      privateList.write({ todos: [{ subject: "private" }] });
      expect(listener.mock.lastCall?.[0]).toMatchObject([
        { subject: "private" },
      ]);
    } finally {
      unsubscribe();
    }
  });
});
