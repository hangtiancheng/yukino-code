import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "@/agent/events.js";
import { Agent } from "@/agent/index.js";
import { ConversationManager } from "@/conversation/index.js";
import type { LLMClient } from "@/llm/client.js";
import { PermissionChecker } from "@/permissions/index.js";
import {
  createPlanPath,
  getCurrentPlanPath,
  getOrCreatePlanPath,
} from "@/plan-file/index.js";
import { SkillCatalog } from "@/skills/catalog.js";
import { LoadSkillTool } from "@/skills/load-skill-tool.js";
import { yukinoPath } from "@/storage/paths.js";
import { AgentTool, type TeammateRunOptions } from "@/subagent/agent-tool.js";
import type { AgentDefinition } from "@/subagent/definition.js";
import { spawnSubagent } from "@/subagent/spawn.js";
import { TaskManager } from "@/subagent/task-manager.js";
import {
  cloneRegistryForFork,
  cloneRegistryForTeammate,
  filterToolsForAgent,
} from "@/subagent/tool-filter.js";
import { FileMailbox } from "@/teams/file-mailbox.js";
import { TeamManager } from "@/teams/index.js";
import { MSG_PLAN_APPROVAL_REQUEST } from "@/teams/protocol.js";
import { getNameRegistry } from "@/teams/registry.js";
import { SharedTaskStore } from "@/teams/shared-task.js";
import { readTeamFile } from "@/teams/team-file.js";
import { TeamCreateTool } from "@/teams/tools.js";
import { McpCallTool } from "@/tools/mcp-call.js";
import { ToolRegistry } from "@/tools/registry.js";
import { ToolSearchTool } from "@/tools/tool-search.js";
import type { Tool, PermissionRequestHandler } from "@/tools/types.js";
import {
  createPermissionRequestHandler,
  type PermissionRequest,
} from "@/ui/permission-request.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof os>()),
  homedir: vi.fn(),
}));

let directory: string;
let manager: TeamManager;
beforeEach(() => {
  directory = mkdtempSync(join(os.tmpdir(), "yukino-delegation-review-"));
  vi.mocked(os.homedir).mockReturnValue(directory);
  manager = new TeamManager(directory);
  getNameRegistry().clear();
});
afterEach(async () => {
  await manager.stopAll();
  vi.useRealTimers();
  vi.restoreAllMocks();
  getNameRegistry().clear();
  rmSync(directory, { recursive: true, force: true });
});

const end = {
  type: "stream_end",
  stopReason: "end_turn",
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  },
} as const;
const provider = {
  name: "test",
  protocol: "openai",
  model: "test",
  base_url: "http://localhost:1",
} as const;

function tool(name: string, category: Tool["category"] = "read"): Tool {
  return {
    name,
    category,
    description: name,
    schema: () => ({
      name,
      description: name,
      input_schema: { type: "object", properties: {} },
    }),
    execute: vi.fn(() => Promise.resolve({ output: "ok", isError: false })),
  };
}

function client(
  inspect: (conversation: ConversationManager) => void = () => undefined,
): LLMClient {
  return {
    setSystemPrompt: vi.fn(),
    async *stream(conversation) {
      await Promise.resolve();
      inspect(conversation);
      yield { type: "text_delta", text: "done" };
      yield end;
    },
  };
}

describe("delegated lifecycle regressions", () => {
  it.each(["defined", "fork"])(
    "runs foreground %s subagents concurrently and pairs results in source order",
    async (kind) => {
      const releases = new Map<string, (output: string) => void>();
      const started: string[] = [];
      const registry = new ToolRegistry();
      const conversation = new ConversationManager();
      conversation.addUserMessage("Run two independent tasks");
      const tasks = new TaskManager();
      const run = (context?: { toolCallId?: string }) => {
        const id = context?.toolCallId ?? "missing";
        started.push(id);
        return new Promise<string>((resolve) => releases.set(id, resolve));
      };
      const agentTool = new AgentTool(
        directory,
        registry,
        (_definition, _prompt, background, _model, _cwd, context) => {
          expect(background).toBe(false);
          return run(context);
        },
        conversation,
        (_prompt, _conversation, _registry, _model, context) => run(context),
        tasks,
      );
      registry.register(agentTool);
      let request = 0;
      const parentClient: LLMClient = {
        setSystemPrompt: vi.fn(),
        async *stream() {
          await Promise.resolve();
          if (request++ === 0) {
            for (const id of ["first", "second"]) {
              yield {
                type: "tool_call_complete",
                toolId: id,
                toolName: "Agent",
                arguments: {
                  description: id,
                  prompt: `Handle ${id}`,
                  run_in_background: false,
                  ...(kind === "defined"
                    ? { subagent_type: "general-purpose" }
                    : {}),
                },
              };
            }
          }
          yield end;
        },
      };
      const parent = new Agent({
        client: parentClient,
        registry,
        conversation,
        checker: new PermissionChecker(directory, "bypassPermissions"),
        cwd: directory,
        taskManager: tasks,
      });
      const results: Extract<AgentEvent, { type: "tool_result" }>[] = [];
      const done = (async () => {
        for await (const event of parent.run()) {
          if (event.type === "tool_result") {
            results.push(event);
          }
        }
      })();
      try {
        await vi.waitFor(() => {
          expect(started).toEqual(["first", "second"]);
        });
        expect(results).toEqual([]);
        releases.get("second")?.("second output");
        await vi.waitFor(() => {
          expect(results).toHaveLength(1);
        });
        expect(results[0]).toMatchObject({
          toolId: "second",
          isError: false,
        });
        expect(results[0].output).toContain("second output");
        releases.get("first")?.("first output");
        await done;
        const saved = conversation
          .getMessages()
          .find((message) => message.toolResults)?.toolResults;
        expect(saved?.map((result) => result.toolUseId)).toEqual([
          "first",
          "second",
        ]);
        expect(saved?.[0].content).toContain("first output");
        expect(saved?.[1].content).toContain("second output");
        expect(tasks.list()).toEqual([]);
      } finally {
        releases.get("first")?.("cleanup");
        releases.get("second")?.("cleanup");
        await done;
      }
    },
  );

  it("keeps nested definition agents in their caller's isolated work directory", async () => {
    const isolated = join(directory, "isolated");
    mkdirSync(isolated);
    const spawn = vi.fn(() => Promise.resolve("done"));
    const agent = new AgentTool(directory, new ToolRegistry(), spawn);
    await agent.execute(
      { cwd: isolated },
      {
        description: "nested worker",
        prompt: "work",
        subagent_type: "general-purpose",
      },
    );
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ name: "general-purpose" }),
      "work",
      false,
      undefined,
      isolated,
      expect.objectContaining({ cwd: isolated }),
    );
  });
  it("interrupts an agent waiting on a host approval that never resolves", async () => {
    const controller = new AbortController();
    const write = tool("WriteProbe", "write");
    const execute = vi.spyOn(write, "execute");
    const registry = new ToolRegistry();
    registry.register(write);
    const conversation = new ConversationManager();
    conversation.addUserMessage("write");
    let asked!: () => void;
    const started = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const handler: PermissionRequestHandler = (
      _name,
      _args,
      _decision,
      _id,
      signal,
    ) => {
      expect(signal).toBe(controller.signal);
      asked();
      return new Promise(() => undefined);
    };
    const agent = new Agent({
      client: {
        setSystemPrompt: vi.fn(),
        async *stream() {
          await Promise.resolve();
          yield {
            type: "tool_call_complete",
            toolId: "write",
            toolName: "WriteProbe",
            arguments: {},
          };
          yield end;
        },
      },
      registry,
      conversation,
      cwd: directory,
      checker: new PermissionChecker(directory),
      abortSignal: controller.signal,
      onPermissionRequest: handler,
    });
    const events = (async () => {
      const collected = [];
      for await (const event of agent.run()) {
        collected.push(event);
      }
      return collected;
    })();
    await started;
    controller.abort();
    expect((await events).at(-1)).toMatchObject({
      type: "loop_complete",
      stopReason: "interrupted",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("removes cancelled queued approvals and advances past a cancelled active dialog", async () => {
    const resolver: {
      current: ((action: "allow" | "deny" | "allowAlways") => void) | null;
    } = { current: null };
    const queue: { current: { present: () => void; deny: () => void }[] } = {
      current: [],
    };
    const shown: (PermissionRequest | null)[] = [];
    const ask = createPermissionRequestHandler({
      resolver,
      queue,
      present: (request) => {
        shown.push(request);
      },
    });
    const first = new AbortController();
    const second = new AbortController();
    const a = ask(
      "WriteFile",
      {},
      { effect: "ask", reason: "approval" },
      "same-id",
      first.signal,
      { agentName: "planner", cwd: directory },
    );
    expect(shown[0]).toMatchObject({ agentName: "planner", cwd: directory });
    const b = ask(
      "WriteFile",
      {},
      { effect: "ask", reason: "approval" },
      "same-id",
      second.signal,
    );
    const c = ask(
      "WriteFile",
      {},
      { effect: "ask", reason: "approval" },
      "same-id",
    );
    second.abort();
    expect(await b).toBe("deny");
    expect(queue.current).toHaveLength(1);
    first.abort();
    expect(await a).toBe("deny");
    expect(shown.at(-1)?.requestId).not.toBe(shown[0]?.requestId);
    expect(queue.current).toHaveLength(0);
    resolver.current?.("allow");
    expect(await c).toBe("allow");
  });

  it("gives separate read-only runs separate plan paths without replacing the leader's plan", async () => {
    const parent = new PermissionChecker(directory, "default");
    const leaderPath = getOrCreatePlanPath(parent);
    parent.planFilePath = leaderPath;
    const paths: string[] = [];
    const child = client((conversation) => {
      const content = JSON.stringify(conversation.getMessages());
      const match = /Plan file: ([^\\\n"]+)/.exec(content);
      expect(content).not.toContain(leaderPath);
      if (match?.[1]) {
        paths.push(match[1]);
      }
    });
    await Promise.all(
      ["first", "second"].map((name) =>
        spawnSubagent(
          { name, description: name, permissionMode: "plan" },
          name,
          child,
          new ToolRegistry(),
          provider,
          directory,
          undefined,
          undefined,
          undefined,
          parent,
        ),
      ),
    );
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(2);
    expect(getCurrentPlanPath(parent)).toBe(leaderPath);
  });

  it("preserves a teammate conversation across follow-up runs without duplicating role instructions", async () => {
    const conversation = new ConversationManager();
    const snapshots: string[] = [];
    const runClient = client((state) => {
      snapshots.push(JSON.stringify(state.getMessages()));
    });
    for (const prompt of ["first assignment", "follow-up assignment"]) {
      await spawnSubagent(
        { name: "worker", description: "worker" },
        prompt,
        runClient,
        new ToolRegistry(),
        provider,
        directory,
        undefined,
        undefined,
        undefined,
        undefined,
        { conversation, backgroundTasks: false },
      );
    }
    expect(snapshots[1]).toContain("first assignment");
    expect(snapshots[1]).toContain("follow-up assignment");
    expect(
      snapshots[1]?.match(/not an instruction to take over/g),
    ).toHaveLength(1);
  });

  it("runs background definitions asynchronously in the caller's task registry", async () => {
    mkdirSync(yukinoPath("agents"), { recursive: true });
    writeFileSync(
      yukinoPath("agents", "worker.md"),
      "---\nname: async-worker\nbackground: true\n---\nWork in the background",
    );
    const hostTasks = new TaskManager();
    const localTasks = new TaskManager();
    let finish!: (output: string) => void;
    const pending = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const spawn = vi.fn(
      (_definition: AgentDefinition, _prompt: string, _background: boolean) =>
        pending,
    );
    const agent = new AgentTool(
      directory,
      new ToolRegistry(),
      spawn,
      undefined,
      undefined,
      hostTasks,
    );
    const result = await agent.execute(
      { cwd: directory, taskManager: localTasks },
      { description: "worker", prompt: "work", subagent_type: "async-worker" },
    );
    expect(result.output).toContain("task_id:");
    expect(hostTasks.list()).toHaveLength(0);
    expect(localTasks.list()).toHaveLength(1);
    finish("done");
    await localTasks.waitAll();
    expect(spawn.mock.calls[0]?.[2]).toBe(true);
  });

  it("never silently routes a teammate request to a one-shot subagent", async () => {
    const spawn = vi.fn(() => Promise.resolve("wrong route"));
    const result = await new AgentTool(
      directory,
      new ToolRegistry(),
      spawn,
    ).execute(
      { cwd: directory },
      {
        description: "worker",
        prompt: "work",
        team_name: "squad",
        subagent_type: "general-purpose",
      },
    );
    expect(result.isError).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("keeps stopped background agents stopped when their runners return errors during cancellation", async () => {
    const tasks = new TaskManager();
    const agent = new AgentTool(
      directory,
      new ToolRegistry(),
      (_definition, _prompt, _background, _model, _cwd, context) =>
        new Promise((_resolve, reject) => {
          context?.abortSignal?.addEventListener(
            "abort",
            () => {
              reject(new Error("aborted runner"));
            },
            { once: true },
          );
        }),
      undefined,
      undefined,
      tasks,
    );
    await agent.execute(
      { cwd: directory },
      {
        description: "worker",
        prompt: "work",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
    );
    await Promise.resolve();
    const task = tasks.list()[0];
    await tasks.stopAndWait(task.id);
    expect(task.status).toBe("cancelled");
    expect(task.output).toBe("Stopped by user");
  });
});

describe("team approval and persistence regressions", () => {
  it("rejects whitespace team names before deleting the existing team and rejects mailbox traversal", async () => {
    manager.create("existing");
    const result = await new TeamCreateTool(manager).execute(
      { cwd: directory },
      { team_name: "  " },
    );
    expect(result.isError).toBe(true);
    expect(manager.get("existing")).toBeDefined();
    expect(() => new FileMailbox(directory, "../escape")).toThrow("Invalid");
    expect(() => manager.get("existing")?.addMember("leader")).toThrow(
      "Invalid",
    );
  });

  it("does not let old idle mail overwrite a newer in-process assignment's live state", async () => {
    const team = manager.create("squad");
    team.spawnTeammate("worker", "first", () => Promise.resolve("done"));
    await vi.waitFor(() => {
      expect(manager.hasLeaderNotifications()).toBe(true);
    });
    await team.sendMessage("leader", "worker", "second");
    expect(team.getMember("worker")?.uiState?.status).toBe("running");
    manager.drainLeaderMailbox();
    expect(team.getMember("worker")?.uiState?.status).toBe("running");
  });
  it("honors teammate tool restrictions and models under parent permission precedence", async () => {
    const parent = new PermissionChecker(directory, "bypassPermissions");
    const registry = new ToolRegistry();
    registry.register(tool("WriteFile", "write"));
    registry.register(tool("ReadFile"));
    const agent = new AgentTool(directory, registry, () =>
      Promise.resolve("unused"),
    );
    let options: TeammateRunOptions | undefined;
    let scoped: ToolRegistry | undefined;
    agent.setTeamManager(manager, (tools, _checker, _cwd, config) => {
      scoped = tools;
      options = config;
      return () => Promise.resolve("read-only findings");
    });
    const result = await agent.execute(
      { cwd: directory, permissionChecker: parent },
      {
        description: "plan worker",
        prompt: "review",
        team_name: "squad",
        name: "planner",
        subagent_type: "plan",
        model: "chosen-model",
      },
    );
    expect(result.isError).toBe(false);
    expect(options?.definition.name).toBe("plan");
    expect(options?.modelOverride).toBe("chosen-model");
    expect(scoped?.get("WriteFile")).toBeUndefined();
    expect(scoped?.get("SendMessage")).toBeDefined();
    await vi.waitFor(() => {
      expect(manager.hasLeaderNotifications()).toBe(true);
    });
    expect(manager.drainLeaderMailbox().join("\n")).not.toContain(
      "plan_approval_request",
    );
    expect(manager.get("squad")?.getMember("planner")?.checker?.mode).toBe(
      "bypassPermissions",
    );
  });

  it("rolls a failed teammate runner factory back out of memory and disk", async () => {
    const agent = new AgentTool(directory, new ToolRegistry(), () =>
      Promise.resolve("unused"),
    );
    agent.setTeamManager(manager, () => {
      throw new Error("factory failed");
    });
    const result = await agent.execute(
      { cwd: directory },
      {
        description: "worker",
        prompt: "work",
        team_name: "squad",
        name: "worker",
      },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("factory failed");
    expect(manager.get("squad")?.listMembers()).toEqual([]);
    expect(readTeamFile(directory, "squad")?.members).toEqual([]);
  });

  it("automatically approves the submitted plan without leader review or tool authorization", async () => {
    const parent = new PermissionChecker(directory, "default");
    manager.setPermissionChecker(parent);
    const team = manager.create("squad");
    const checker = parent.forSubagent(directory, "plan");
    checker.teammate = true;
    checker.planFilePath = createPlanPath();
    writeFileSync(checker.planFilePath, "Only this worker's plan");
    const modes: string[] = [];
    const run = vi.fn(() => {
      modes.push(checker.mode);
      return Promise.resolve("plan ready");
    });
    team.spawnTeammate("planner", "plan", run, checker, undefined, directory, {
      planApprovalRequired: true,
    });
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(2);
    });
    expect(modes).toEqual(["plan", "default"]);
    expect(parent.mode).toBe("default");
    expect(
      checker.check("Bash", "command", { command: "pnpm test" }).effect,
    ).toBe("ask");
    const notification = manager.drainLeaderMailbox().join("\n");
    expect(notification).toContain(`type=${MSG_PLAN_APPROVAL_REQUEST}`);
    expect(notification).toContain("Only this worker's plan");
    expect(notification).toMatch(/requestId=req-[a-f0-9]+/);
  });

  it("persists member removal instead of merging the removed reservation back", () => {
    const team = manager.create("squad");
    team.addMember("failed-reservation");
    team.removeMember("failed-reservation");
    expect(readTeamFile(directory, "squad")?.members).toEqual([]);
  });

  it("reports failure details and unregisters a failed teammate immediately", async () => {
    const team = manager.create("squad");
    team.spawnTeammate("worker", "fail", () =>
      Promise.reject(new Error("real failure")),
    );
    await team.getMember("worker")?.done;
    expect(getNameRegistry().resolve("worker")).toBeUndefined();
    expect(manager.drainLeaderMailbox().join("\n")).toContain("real failure");
  });

  it("does not evict cancelled tasks while their cleanup is still pending", async () => {
    const tasks = new TaskManager();
    let finish!: (value: string) => void;
    const cancelled = tasks.create(
      "slow cleanup",
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
      () => undefined,
    );
    await Promise.resolve();
    tasks.stop(cancelled.id);
    const completed = Array.from({ length: 201 }, () =>
      tasks.create(
        "finished",
        () => Promise.resolve("ok"),
        () => undefined,
      ),
    );
    await Promise.all(completed.map((task) => task.done));
    tasks.drainNotifications();
    expect(tasks.get(cancelled.id)).toBe(cancelled);
    finish("late");
    await cancelled.done;
    expect(tasks.drainNotifications()).toEqual([cancelled]);
  });

  it("assigns unique task ids across managers and waits for follow-ups spawned while waiting", async () => {
    const first = new TaskManager();
    const second = new TaskManager();
    const a = first.create(
      "first",
      async () => {
        await Promise.resolve();
        first.create(
          "follow-up",
          () => Promise.resolve("follow-up"),
          () => undefined,
        );
        return "first";
      },
      () => undefined,
    );
    const b = second.create(
      "second",
      () => Promise.resolve("second"),
      () => undefined,
    );
    expect(a.id).not.toBe(b.id);
    await first.waitAll();
    await second.waitAll();
    expect(first.list().map((task) => task.status)).toEqual([
      "completed",
      "completed",
    ]);
  });

  it("does not overwrite a corrupted shared board with stale cached tasks", () => {
    const path = join(directory, "tasks.json");
    const store = new SharedTaskStore(path);
    store.create("original");
    writeFileSync(path, "not valid JSON");
    expect(() => store.create("new")).toThrow("unreadable");
    expect(() => store.update("1", { status: "completed" })).toThrow(
      "unreadable",
    );
    expect(readFileSync(path, "utf-8")).toBe("not valid JSON");
  });

  it("rejects dependencies before the other task exists without consuming an ID", () => {
    const store = new SharedTaskStore(join(directory, "tasks.json"));
    expect(() => store.create("first", "", "", ["2"])).toThrow(
      "Unknown dependency",
    );
    expect(store.listTasks()).toEqual([]);
    expect(store.create("first").id).toBe("1");
    expect(store.create("second").id).toBe("2");
    store.update("1", { addBlocks: ["2"] });
    expect(store.get("2")?.blockedBy).toEqual(["1"]);
  });
});

describe("delegated tool boundaries", () => {
  it("loads delegated skills locally without activating the parent's host or recursively forking", async () => {
    const source = join(directory, ".agents", "skills", "demo");
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: demo\ndescription: demo\ncontext: fork\n---\nDelegated instructions.",
    );
    const catalog = new SkillCatalog();
    catalog.load(directory);
    const activateSkill = vi.fn();
    const runSubagent = vi.fn(() => Promise.resolve("wrong fork"));
    const registry = new ToolRegistry();
    registry.register(
      new LoadSkillTool(
        catalog,
        { activateSkill },
        { activateSkill, runSubagent, snapshotParentMessages: () => "parent" },
      ),
    );
    const child = filterToolsForAgent(registry, undefined, undefined, false);
    const result = await child
      .get("LoadSkill")
      ?.execute({ cwd: directory }, { name: "demo" });
    expect(result?.output).toContain("Delegated instructions.");
    expect(activateSkill).not.toHaveBeenCalled();
    expect(runSubagent).not.toHaveBeenCalled();
  });
  it.each(["defined", "fork", "teammate"])(
    "scopes MCP discovery and dispatch for a %s registry",
    async (kind) => {
      const registry = new ToolRegistry();
      registry.mcpLoadingMode = "dispatch";
      registry.exposeToolSearch = true;
      registry.exposeMcpCall = true;
      registry.register({ ...tool("mcp__allowed"), deferred: true });
      registry.register({ ...tool("mcp__blocked"), deferred: true });
      registry.register(new ToolSearchTool(registry));
      registry.register(new McpCallTool(registry));
      registry.register({ ...tool("LocalDeferred"), deferred: true });
      registry.markDiscovered("LocalDeferred");
      const scoped =
        kind === "fork"
          ? cloneRegistryForFork(registry)
          : kind === "teammate"
            ? cloneRegistryForTeammate(registry)
            : filterToolsForAgent(registry, undefined, ["mcp__blocked"], false);
      expect(scoped.getAllSchemas().map((schema) => schema.name)).toEqual(
        expect.arrayContaining(["ToolSearch", "McpCall", "LocalDeferred"]),
      );
      const search = await scoped
        .get("ToolSearch")
        ?.execute(
          { cwd: directory },
          { query: "select:mcp__allowed,mcp__blocked" },
        );
      if (kind === "defined") {
        expect(search?.output).not.toContain("mcp__blocked");
      }
      expect(scoped.get("McpCall")).not.toBe(registry.get("McpCall"));
    },
  );

  it("does not give one-shot workers a leader-authenticated messaging channel", () => {
    const registry = new ToolRegistry();
    for (const name of [
      "SendMessage",
      "TeamCreate",
      "TeamDelete",
      "ReadFile",
    ]) {
      registry.register(tool(name));
    }
    for (const scoped of [
      cloneRegistryForFork(registry),
      filterToolsForAgent(registry, undefined, undefined, false),
    ]) {
      expect(scoped.get("SendMessage")).toBeUndefined();
      expect(scoped.get("TeamCreate")).toBeUndefined();
      expect(scoped.get("TeamDelete")).toBeUndefined();
      expect(scoped.get("ReadFile")).toBeDefined();
    }
  });
});
