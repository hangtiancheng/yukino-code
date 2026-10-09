import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createToolRegistry } from "@/bootstrap/tool-registry.js";
import { ConversationManager } from "@/conversation/index.js";
import type { LLMClient } from "@/llm/client.js";
import type { StreamEvent } from "@/llm/events.js";
import { PermissionChecker } from "@/permissions/index.js";
import { AgentTool } from "@/subagent/agent-tool.js";
import { spawnSubagent } from "@/subagent/spawn.js";
import { TaskManager } from "@/subagent/task-manager.js";
import {
  cloneRegistryForFork,
  filterToolsForAgent,
} from "@/subagent/tool-filter.js";
import { TeamManager } from "@/teams/index.js";
import { getNameRegistry } from "@/teams/registry.js";
import { SharedTaskStore } from "@/teams/shared-task.js";
import { TaskStopTool } from "@/teams/task-stop.js";
import { TeamTaskUpdateTool } from "@/teams/task-tools.js";
import { readTeamFile } from "@/teams/team-file.js";
import { TaskList } from "@/todo/index.js";
import { TaskStore } from "@/todo/store.js";
import { TaskUpdateTool, TodoWriteTool } from "@/todo/tools.js";
import { BashTool } from "@/tools/bash.js";
import { ToolRegistry } from "@/tools/registry.js";
import type { Tool, ToolContext } from "@/tools/types.js";

vi.mock("node:os", async (original) => ({
  ...(await original<typeof os>()),
  homedir: vi.fn(),
}));

let directory: string;
let manager: TeamManager;

beforeEach(() => {
  directory = mkdtempSync(join(os.tmpdir(), "yukino-worker-life-"));
  vi.mocked(os.homedir).mockReturnValue(directory);
  manager = new TeamManager(directory);
  getNameRegistry().clear();
});

afterEach(async () => {
  await manager.dispose();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function tool(name: string, dispose?: () => Promise<void>): Tool {
  return {
    name,
    description: name,
    category: "read",
    schema: () => ({
      name,
      description: name,
      input_schema: { type: "object", properties: {} },
    }),
    execute: () => Promise.resolve({ output: "ok", isError: false }),
    dispose,
  };
}

function end(reason = "end_turn"): StreamEvent {
  return {
    type: "stream_end",
    stopReason: reason,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  };
}

describe("owned and borrowed tool cleanup", () => {
  it("disposes once, waits for every owned resource even when one fails, and never closes borrowed tools", async () => {
    const registry = new ToolRegistry();
    const failure = vi.fn(() => Promise.reject(new Error("cleanup failure")));
    let finish!: () => void;
    const second = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const borrowed = vi.fn(() => Promise.resolve());
    registry.register(tool("Failure", failure));
    registry.register(tool("Second", second));
    registry.registerBorrowed(tool("Borrowed", borrowed));
    const disposal = registry.dispose();
    expect(registry.dispose()).toBe(disposal);
    expect(() => {
      registry.register(tool("Late"));
    }).toThrow("disposed");
    finish();
    await expect(disposal).rejects.toThrow("Tool cleanup failed");
    expect(failure).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(borrowed).not.toHaveBeenCalled();
    expect(registry.listTools()).toEqual([]);
  });

  it("transfers subprocess tool ownership without shutting it down with the source registry", async () => {
    const source = new ToolRegistry();
    const cleanup = vi.fn(() => Promise.resolve());
    const resource = tool("Resource", cleanup);
    source.register(resource);
    const target = new ToolRegistry();
    target.registerBorrowed(resource);
    target.takeOwnershipFrom(source);
    await source.dispose();
    expect(cleanup).not.toHaveBeenCalled();
    await target.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("still cleans up owned resources removed or replaced in the registry", async () => {
    const registry = new ToolRegistry();
    const oldCleanup = vi.fn(() => Promise.resolve());
    const removedCleanup = vi.fn(() => Promise.resolve());
    registry.register(tool("Replace", oldCleanup));
    registry.register(tool("Remove", removedCleanup));
    registry.register(tool("Replace"));
    registry.unregister("Remove");
    await registry.dispose();
    expect(oldCleanup).toHaveBeenCalledOnce();
    expect(removedCleanup).toHaveBeenCalledOnce();
  });

  it.each(["completed", "failed", "interrupted", "maxTurns"] as const)(
    "reaps a real owned background Bash process when a subagent ends as %s",
    async (outcome) => {
      const registry = new ToolRegistry();
      const parentTasks = new TaskManager();
      const bash = new BashTool();
      bash.taskManager = parentTasks;
      const borrowedCleanup = vi.fn(() => Promise.resolve());
      registry.register(tool("ParentResource", borrowedCleanup));
      registry.register(bash);
      let localTasks: TaskManager | undefined;
      const pidFile = join(directory, "worker.pid");
      const controller = new AbortController();
      registry.register({
        ...tool("StartBackground"),
        execute: async (context: ToolContext) => {
          localTasks = context.taskManager ?? undefined;
          const result = await bash.execute(context, {
            command: `printf '%s' "$$" > ${JSON.stringify(pidFile)}; exec sleep 30`,
            run_in_background: true,
          });
          expect(result.isError).toBe(false);
          await vi.waitFor(() => {
            expect(existsSync(pidFile)).toBe(true);
          });
          if (outcome === "interrupted") {
            controller.abort();
          }
          return { output: "started", isError: false };
        },
      });
      let calls = 0;
      const client: LLMClient = {
        setSystemPrompt: () => undefined,
        async *stream() {
          await Promise.resolve();
          if (calls++ === 0) {
            yield {
              type: "tool_call_complete",
              toolId: "start",
              toolName: "StartBackground",
              arguments: {},
            };
            yield end("tool_use");
          } else {
            if (outcome === "failed") {
              throw new Error("model failed");
            }
            yield { type: "text_delta", text: "done" };
            yield end();
          }
        },
      };
      const running = spawnSubagent(
        {
          name: "worker",
          description: "worker",
          maxTurns: outcome === "maxTurns" ? 1 : undefined,
        },
        "work",
        client,
        registry,
        {
          name: "test",
          protocol: "openai",
          model: "test",
          base_url: "http://127.0.0.1:1",
          api_key: "test",
        },
        directory,
        undefined,
        undefined,
        undefined,
        new PermissionChecker(directory, "bypassPermissions"),
        { abortSignal: controller.signal },
      );
      try {
        if (outcome === "failed" || outcome === "maxTurns") {
          await expect(running).rejects.toThrow(
            outcome === "failed" ? "model failed" : "maximum iterations",
          );
        } else {
          expect(await running).toContain(
            outcome === "interrupted" ? "[Interrupted]" : "done",
          );
        }
        expect(parentTasks.list()).toEqual([]);
        expect(localTasks?.list()[0]?.status).toBe("cancelled");
        const pid = Number(readFileSync(pidFile, "utf8"));
        expect(() => process.kill(pid, 0)).toThrow();
        expect(borrowedCleanup).not.toHaveBeenCalled();
        expect(registry.get("Bash")).toBe(bash);
      } finally {
        controller.abort();
        await localTasks?.stopAll();
        await registry.dispose();
      }
    },
    15_000,
  );

  it("releases cancellation closures only after runners settle and forbids clearing live tasks", async () => {
    const tasks = new TaskManager();
    let finish!: (result: string) => void;
    const cancel = vi.fn();
    const task = tasks.create(
      "pending",
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
      cancel,
    );
    await Promise.resolve();
    expect(() => {
      tasks.clear();
    }).toThrow("Stop and await");
    tasks.stop(task.id);
    expect(task.cancel).toBe(cancel);
    expect(() => {
      tasks.clear();
    }).toThrow("Stop and await");
    finish("late");
    await task.done;
    expect(task.cancel).not.toBe(cancel);
    expect(tasks.drainNotifications()).toEqual([task]);
    tasks.clear();
    expect(tasks.list()).toEqual([]);
  });
});

describe("persistent teammate cleanup boundaries", () => {
  it("publishes termination only after in-process cleanup settles", async () => {
    const team = manager.create("squad");
    let started!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    team.spawnTeammate(
      "alice",
      "fail",
      () => Promise.reject(new Error("failed")),
      undefined,
      undefined,
      directory,
      {
        cleanup: () => {
          started();
          return new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
      },
    );
    const member = team.getMember("alice");
    await cleanupStarted;
    expect(team.leaderMailbox.unreadCount()).toBe(0);
    expect(member?.done).toBeDefined();
    finish();
    await member?.done;
    expect(team.leaderMailbox.receiveSync().at(-1)?.text).toContain(
      "reason: failed",
    );
    expect(member?.done).toBeUndefined();
  });
  it("bounds terminal roster retention without evicting idle teammates", async () => {
    const team = manager.create("squad");
    team.spawnTeammate("idle-worker", "work", () => Promise.resolve("idle"));
    for (let i = 0; i < 201; i++) {
      const name = `failed-${String(i)}`;
      team.spawnTeammate(name, "fail", () =>
        Promise.reject(new Error("failed")),
      );
      await team.getMember(name)?.done;
    }
    expect(team.getMember("failed-0")).toBeUndefined();
    expect(team.getMember("idle-worker")?.active).toBe(true);
    expect(team.listMembers()).toHaveLength(201);
    expect(readTeamFile(directory, "squad")?.members).toHaveLength(201);
  });

  it("allows a fully reaped failed teammate name to be reused", async () => {
    const agent = new AgentTool(directory, new ToolRegistry(), () =>
      Promise.resolve("unused"),
    );
    let fail = true;
    agent.setTeamManager(
      manager,
      () => () =>
        fail ? Promise.reject(new Error("failed")) : Promise.resolve("ready"),
    );
    const args = {
      description: "worker",
      prompt: "work",
      team_name: "squad",
      name: "alice",
    };
    await agent.execute({ cwd: directory }, args);
    await manager.get("squad")?.getMember("alice")?.done;
    fail = false;
    expect((await agent.execute({ cwd: directory }, args)).isError).toBe(false);
    await vi.waitFor(() => {
      expect(manager.get("squad")?.getMember("alice")?.uiState?.status).toBe(
        "idle",
      );
    });
    expect(manager.get("squad")?.listMembers()).toHaveLength(1);
  });
  it("retains registry, conversation runner and ownership while idle, then cleans them on stop exactly once", async () => {
    const parent = new ToolRegistry();
    const cleanup = vi.fn(() => Promise.resolve());
    parent.register(tool("SharedResource", cleanup));
    const agent = new AgentTool(directory, parent, () =>
      Promise.resolve("unused"),
    );
    let scoped: ToolRegistry | undefined;
    const run = vi.fn(() => Promise.resolve("turn result"));
    agent.setTeamManager(manager, (registry) => {
      scoped = registry;
      return run;
    });
    await agent.execute(
      { cwd: directory },
      {
        description: "worker",
        prompt: "work",
        team_name: "squad",
        name: "alice",
      },
    );
    const team = manager.get("squad");
    const store = manager.getTaskStore("squad");
    const task = store.create("unfinished", "", "alice");
    const completed = store.create("done", "", "alice");
    store.update(completed.id, { status: "completed" });
    await vi.waitFor(() => {
      expect(team?.getMember("alice")?.uiState?.status).toBe("idle");
    });
    expect(store.get(task.id)?.owner).toBe("alice");
    expect(scoped?.get("SharedResource")).toBeDefined();
    await team?.sendMessage("leader", "alice", "follow up");
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(2);
    });
    const member = team?.getMember("alice");
    await Promise.all([team?.stopMember("alice"), team?.stopMember("alice")]);
    expect(member).toMatchObject({
      active: false,
      checker: undefined,
      cancel: undefined,
      signal: undefined,
    });
    expect(member?.uiState?.status).toBe("stopped");
    expect(scoped?.listTools()).toEqual([]);
    expect(cleanup).not.toHaveBeenCalled();
    expect(store.get(task.id)).toMatchObject({ status: "pending", owner: "" });
    expect(store.get(completed.id)).toMatchObject({
      status: "completed",
      owner: "alice",
    });
    expect(getNameRegistry().resolve("alice")).toBeUndefined();
    await parent.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("still clears live references and releases tasks when cleanup fails", async () => {
    const team = manager.create("squad");
    const store = manager.getTaskStore("squad");
    store.create("unfinished", "", "alice");
    const checker = new PermissionChecker(directory, "acceptEdits").forSubagent(
      directory,
    );
    const cleanup = vi.fn(() => Promise.reject(new Error("cleanup failed")));
    team.spawnTeammate(
      "alice",
      "fail",
      () => Promise.reject(new Error("worker failed")),
      checker,
      undefined,
      directory,
      { cleanup },
    );
    const member = team.getMember("alice");
    await member?.done;
    expect(member?.uiState?.status).toBe("failed");
    expect(member?.checker).toBeUndefined();
    expect(member?.cancel).toBeUndefined();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(store.get("1")).toMatchObject({ status: "pending", owner: "" });
  });

  it("reclaims stale teammate ownership when restoring a session", () => {
    const team = manager.create("squad");
    const member = team.addMember("alice");
    member.active = true;
    team.persist();
    const store = manager.getTaskStore("squad");
    store.create("unfinished", "", "alice");
    new TeamManager(directory).get("squad");
    expect(store.get("1")).toMatchObject({ status: "pending", owner: "" });
  });
});

describe("delegation authority", () => {
  it.each([false, true])(
    "allows defined subagents to stop only owned background tasks (background=%s)",
    async (background) => {
      const parent = new ToolRegistry();
      const parentTasks = new TaskManager();
      const ownedTasks = new TaskManager();
      let finishParent!: (output: string) => void;
      const parentTask = parentTasks.create(
        "parent",
        () =>
          new Promise<string>((resolve) => {
            finishParent = resolve;
          }),
        () => undefined,
      );
      let finishChild!: (output: string) => void;
      const ownTask = ownedTasks.create(
        "child",
        () =>
          new Promise<string>((resolve) => {
            finishChild = resolve;
          }),
        () => {
          finishChild("stopped");
        },
      );
      parent.register(new TaskStopTool(manager, parentTasks));
      await Promise.resolve();
      const scoped = filterToolsForAgent(parent, ["*"], undefined, background);
      const stop = scoped.get("TaskStop");
      expect(stop?.schema().input_schema).toMatchObject({
        required: ["task_id"],
        additionalProperties: false,
      });
      expect(stop?.schema().input_schema.properties).not.toHaveProperty(
        "teammate",
      );
      expect(
        (
          await stop?.execute(
            { cwd: directory, taskManager: ownedTasks },
            { task_id: parentTask.id },
          )
        )?.isError,
      ).toBe(true);
      expect(
        (await stop?.execute({ cwd: directory }, { task_id: parentTask.id }))
          ?.isError,
      ).toBe(true);
      expect(
        (
          await stop?.execute(
            { cwd: directory, taskManager: ownedTasks },
            { task_id: ownTask.id },
          )
        )?.isError,
      ).toBe(false);
      expect(ownTask.status).toBe("cancelled");
      expect(parentTask.status).toBe("running");
      finishParent("complete");
      await parentTask.done;
      await scoped.dispose();
      await parent.dispose();
    },
  );
  it("strips team creation from a fork's Agent and isolates TaskStop from the parent", async () => {
    const parent = new ToolRegistry();
    const tasks = new TaskManager();
    const child = new AgentTool(
      directory,
      parent,
      () => Promise.resolve("child"),
      new ConversationManager(),
    );
    child.setTeamManager(manager, () => () => Promise.resolve("worker"));
    parent.register(child);
    parent.register(new TaskStopTool(manager, tasks));
    const fork = cloneRegistryForFork(parent);
    const existing = manager.create("squad");
    existing.addMember("alice");
    const result = await fork
      .get("Agent")
      ?.execute(
        { cwd: directory },
        { description: "bad", prompt: "bad", team_name: "replacement" },
      );
    expect(result?.isError).toBe(true);
    expect(manager.get("squad")).toBe(existing);
    const stop = await fork
      .get("TaskStop")
      ?.execute({ cwd: directory }, { teammate: "alice" });
    expect(stop?.isError).toBe(true);
    await fork.dispose();
  });

  it("does not implicitly replace a team on a mistyped Agent team_name", async () => {
    const existing = manager.create("squad");
    const agent = new AgentTool(directory, new ToolRegistry(), () =>
      Promise.resolve("unused"),
    );
    agent.setTeamManager(manager, () => () => Promise.resolve("worker"));
    const result = await agent.execute(
      { cwd: directory },
      { description: "worker", prompt: "work", team_name: "typo" },
    );
    expect(result.isError).toBe(true);
    expect(manager.list()).toEqual([existing]);
  });
});

describe("task board correctness", () => {
  it("requires a teammate to return work to pending before dropping ownership", () => {
    const store = new SharedTaskStore(join(directory, "board.json"));
    const task = store.create("work");
    store.update(task.id, { status: "in_progress" }, "alice");
    expect(() => store.update(task.id, { owner: "" }, "alice")).toThrow(
      "must have an owner",
    );
    expect(store.get(task.id)).toMatchObject({
      status: "in_progress",
      owner: "alice",
    });
    store.update(task.id, { status: "pending", owner: "" }, "alice");
    expect(store.get(task.id)).toMatchObject({ status: "pending", owner: "" });
  });
  it("keeps leader schemas stable while routing Task tools to the team and child tasks to private lists", async () => {
    const privateList = new TaskList();
    const registry = createToolRegistry(directory, privateList, {
      teamManager: manager,
    });
    const schema = registry.get("TaskUpdate")?.schema();
    await registry
      .get("TaskCreate")
      ?.execute({ cwd: directory }, { subject: "private", description: "" });
    manager.create("squad");
    await registry
      .get("TaskCreate")
      ?.execute({ cwd: directory }, { subject: "shared", description: "" });
    expect(registry.get("TodoWrite")).toBeUndefined();
    expect(privateList.list().map((task) => task.subject)).toEqual(["private"]);
    expect(
      manager
        .getTaskStore("squad")
        .listTasks()
        .map((task) => task.subject),
    ).toEqual(["shared"]);
    expect(registry.get("TaskUpdate")?.schema()).toEqual(schema);
    const fork = cloneRegistryForFork(registry);
    await fork
      .get("TaskCreate")
      ?.execute({ cwd: directory }, { subject: "child", description: "" });
    expect(manager.getTaskStore("squad").listTasks()).toHaveLength(1);
    await fork.dispose();
    await registry.dispose();
  });

  it("atomically rejects competing claims, unresolved dependencies and busy workers", async () => {
    const team = manager.create("squad");
    team.addMember("alice");
    team.addMember("bob");
    const store = manager.getTaskStore("squad");
    const first = store.create("first");
    const second = store.create("second", "", "", [], [first.id]);
    const alice = new TeamTaskUpdateTool(manager, "squad", "alice");
    const bob = new TeamTaskUpdateTool(manager, "squad", "bob");
    expect(
      (
        await alice.execute(
          { cwd: directory },
          { taskId: second.id, status: "in_progress" },
        )
      ).isError,
    ).toBe(true);
    expect(store.get(second.id)).toMatchObject({
      status: "pending",
      owner: "",
    });
    const claims = await Promise.all(
      [alice, bob].map((updater) =>
        updater.execute(
          { cwd: directory },
          { taskId: first.id, status: "in_progress" },
        ),
      ),
    );
    expect(claims.map((result) => result.isError)).toEqual([false, true]);
    expect(
      (
        await bob.execute(
          { cwd: directory },
          { taskId: first.id, status: "completed" },
        )
      ).isError,
    ).toBe(true);
    const third = store.create("third");
    expect(
      (
        await alice.execute(
          { cwd: directory },
          { taskId: third.id, status: "in_progress" },
        )
      ).isError,
    ).toBe(true);
    await alice.execute(
      { cwd: directory },
      { taskId: first.id, status: "completed" },
    );
    expect(
      (
        await bob.execute(
          { cwd: directory },
          { taskId: second.id, status: "in_progress" },
        )
      ).isError,
    ).toBe(false);
    expect(store.get(second.id)?.owner).toBe("bob");
  });

  it("does not reuse deleted private task IDs after resume or an empty TodoWrite", () => {
    const store = new TaskStore("session");
    const list = new TaskList(store);
    list.create("first", "");
    list.create("second", "");
    list.delete("2");
    const resumed = new TaskList(new TaskStore("session"));
    expect(resumed.create("third", "").id).toBe("3");
    resumed.replace([]);
    expect(new TaskList(new TaskStore("session")).create("fourth", "").id).toBe(
      "4",
    );
  });

  it("merges metadata, clears null keys, and cannot bypass dependencies with TodoWrite", async () => {
    const list = new TaskList();
    const first = list.create("first", "", undefined, {
      keep: 1,
      remove: true,
    });
    const second = list.create("second", "");
    list.update(second.id, { addBlockedBy: [first.id] });
    await new TaskUpdateTool(list).execute(
      { cwd: directory },
      { taskId: first.id, metadata: { add: 2, remove: null } },
    );
    expect(list.get(first.id)?.metadata).toEqual({ keep: 1, add: 2 });
    const before = list.list();
    const result = await new TodoWriteTool(list).execute(
      { cwd: directory },
      {
        todos: [
          { id: first.id, subject: "first", status: "pending" },
          { id: second.id, subject: "second", status: "in_progress" },
        ],
      },
    );
    expect(result.isError).toBe(true);
    expect(list.list()).toEqual(before);
  });

  it("does not treat cancelled dependencies as completed and preserves terminal records when releasing an owner", () => {
    const store = new SharedTaskStore(join(directory, "board.json"));
    const first = store.create("cancelled", "", "alice");
    store.update(first.id, { status: "cancelled" });
    const second = store.create("dependent", "", "alice", [], [first.id]);
    expect(() =>
      store.update(second.id, { status: "in_progress" }, "alice"),
    ).toThrow("blocked");
    store.releaseOwner("alice");
    expect(store.get(first.id)).toMatchObject({
      status: "cancelled",
      owner: "alice",
    });
    expect(store.get(second.id)).toMatchObject({
      status: "pending",
      owner: "",
    });
  });
});
