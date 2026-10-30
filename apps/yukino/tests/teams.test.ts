import {
  mkdtempSync as createTempDir,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PermissionChecker } from "@/permissions/index.js";
import { AgentTool } from "@/subagent/agent-tool.js";
import { TeamManager } from "@/teams/index.js";
import {
  createProgress,
  recordTokens,
  recordToolResult,
  recordToolStart,
  recordTurnComplete,
} from "@/teams/progress.js";
import {
  listTeamNames,
  readTeamFile,
  teamConfigPath,
} from "@/teams/team-file.js";
import {
  TeamListTool,
  SendMessageTool,
  TeamCreateTool,
  TeamDeleteTool,
} from "@/teams/tools.js";
import { ToolRegistry } from "@/tools/registry.js";

// The teams directory lives at <home>/.yukino/teams, so the tests redirect the
// entire home directory to a temp dir to avoid leaving residue in the real
// ~/.yukino/teams. os.homedir() reads USERPROFILE on Windows and HOME on other
// platforms, so set both.
let realHome: string | undefined;
let realUserProfile: string | undefined;
let homeDir = "";
const cwds = new Set<string>();
beforeEach(() => {
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  homeDir = createTempDir(join(tmpdir(), "yukino-home-"));
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
});
afterEach(() => {
  if (realHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = realHome;
  }
  if (realUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = realUserProfile;
  }
  rmSync(homeDir, { recursive: true, force: true });
  for (const directory of cwds) {
    rmSync(directory, { recursive: true, force: true });
  }
  cwds.clear();
});
const cwd = () => {
  const directory = createTempDir(join(tmpdir(), "yukino-team-"));
  cwds.add(directory);
  return directory;
};

describe("teammate progress", () => {
  it("tracks active tools, turns, and cumulative tokens", () => {
    const progress = createProgress();

    recordToolStart(progress, "read", "ReadFile", { file_path: "a.ts" });
    recordToolStart(progress, "bash", "Bash", { command: "pwd" });
    recordTokens(progress, 100, 20);
    recordTokens(progress, 200, 30);

    expect(progress.activeTools.at(-1)?.toolName).toBe("Bash");
    expect(progress.tokenCount).toBe(350);

    recordToolResult(progress, "bash");
    expect(progress.activeTools.at(-1)?.toolName).toBe("ReadFile");

    recordTurnComplete(progress);
    expect(progress.turnCount).toBe(1);
    expect(progress.activeTools).toEqual([]);
  });
});

describe("teams orchestration", () => {
  it("spawnTeammate runs the task and posts its result to the leader mailbox", async () => {
    const mgr = new TeamManager(cwd());
    const team = mgr.create("squad");
    team.spawnTeammate(
      "scout",
      "find X",
      (task) => Promise.resolve(`did: ${task}`),
      undefined,
      "agent-tool-call",
    );
    expect(team.getMember("scout")?.uiState?.originToolCallId).toBe(
      "agent-tool-call",
    );

    await vi.waitFor(() => {
      expect(mgr.hasLeaderNotifications()).toBe(true);
    });
    expect(mgr.hasLeaderNotifications()).toBe(true);
    const drained = mgr.drainLeaderMailbox();
    // The teammate sends an [idle] notification with its name after finishing
    expect(
      drained.some((d) => d.includes("scout") && d.includes("[idle]")),
    ).toBe(true);
    expect(mgr.hasLeaderNotifications()).toBe(false);
    expect(mgr.drainLeaderMailbox()).toEqual([]);
  });

  it("a failing teammate reports the error to the leader", async () => {
    const mgr = new TeamManager(cwd());
    mgr
      .create("squad")
      .spawnTeammate("flaky", "boom", () =>
        Promise.reject(new Error("kaboom")),
      );
    await vi.waitFor(() => {
      expect(mgr.list()[0]?.getMember("flaky")?.uiState?.status).toBe("failed");
    });
    expect(mgr.drainLeaderMailbox().some((d) => d.includes("failed"))).toBe(
      true,
    );
  });

  it("TaskStop aborts an active in-process teammate and waits for it to settle", async () => {
    const mgr = new TeamManager(cwd());
    let resolveStarted!: (signal: AbortSignal) => void;
    let cancelled = false;
    const started = new Promise<AbortSignal>((resolve) => {
      resolveStarted = resolve;
    });

    const team = mgr.create("squad");
    team.spawnTeammate(
      "scout",
      "long task",
      async (_task, _onEvent, signal) => {
        if (!signal) {
          throw new Error("missing teammate abort signal");
        }
        resolveStarted(signal);
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
              resolve();
            },
            { once: true },
          );
        });
        return "[Interrupted]";
      },
    );

    const signal = await started;
    await team.stopMember("scout");

    expect(signal.aborted).toBe(true);
    expect(cancelled).toBe(true);
    expect(team.getMember("scout")?.active).toBe(false);
    expect(team.getMember("scout")?.uiState?.status).toBe("stopped");
    expect(
      mgr
        .drainLeaderMailbox()
        .some((message) => message.includes("reason: stopped")),
    ).toBe(true);
  });

  it("cancels every teammate before waiting for shutdown", async () => {
    const team = new TeamManager(cwd()).create("squad");
    const cancelled: string[] = [];
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const first = team.addMember("first");
    first.active = true;
    first.cancel = () => {
      cancelled.push("first");
    };
    first.done = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const second = team.addMember("second");
    second.active = true;
    second.cancel = () => {
      cancelled.push("second");
    };
    second.done = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });

    const stopping = team.stopAll();
    expect(cancelled).toEqual(["first", "second"]);
    finishFirst();
    finishSecond();
    await stopping;
  });

  it("coordination tools create, spawn, message, and list", async () => {
    const mgr = new TeamManager(cwd());

    expect(
      (
        await new TeamCreateTool(mgr).execute(
          {
            cwd: cwd(),
          },
          {},
        )
      ).output,
    ).toContain("created");

    mgr
      .list()[0]
      ?.spawnTeammate("w1", "task A", (task: string) =>
        Promise.resolve(`done:${task}`),
      );
    await vi.waitFor(() => {
      expect(mgr.hasLeaderNotifications()).toBe(true);
    });
    expect(
      mgr
        .drainLeaderMailbox()
        .some((d) => d.includes("w1") && d.includes("[idle]")),
    ).toBe(true);

    const send = await new SendMessageTool(mgr).execute(
      {
        cwd: cwd(),
      },
      { to: "w1", content: "hi" },
    );
    expect(send.isError).toBe(false);
    expect(
      mgr
        .list()[0]
        ?.getMember("w1")
        ?.mailbox.receiveSync()
        .map((m) => m.text),
    ).toContain("hi");

    const list = await new TeamListTool(mgr).execute();
    expect(list.output).toContain(mgr.list()[0]?.name);
    expect(list.output).toContain("w1");
  });

  it("requires approval for mutating coordination tools", () => {
    const project = cwd();
    const mgr = new TeamManager(project);
    const checker = new PermissionChecker(project);
    const mutatingTools = [
      new TeamCreateTool(mgr),
      new SendMessageTool(mgr),
      new TeamDeleteTool(mgr),
    ];

    for (const tool of mutatingTools) {
      expect(tool.category).toBe("command");
      expect(checker.check(tool.name, tool.category, {}).effect).toBe("ask");
    }
    expect(new TeamListTool(mgr).category).toBe("read");
  });

  it("gives spawned teammates a coordination-capable checker", async () => {
    const project = cwd();
    const mgr = new TeamManager(project);
    const captured: PermissionChecker[] = [];
    const tool = new AgentTool(project, new ToolRegistry(), () =>
      Promise.resolve("unused"),
    );
    tool.setTeamManager(mgr, (_registry, checker) => {
      if (checker) {
        captured.push(checker);
      }
      return (task) => Promise.resolve(`done:${task}`);
    });

    const result = await tool.execute(
      { cwd: project },
      {
        kind: "teammate",
        fork: false,
        description: "w1",
        prompt: "task A",
      },
    );
    expect(result.isError).toBe(false);

    // The teammate checker must exempt coordination tools: teammates have no
    // approval dialog, so an "ask" decision would auto-deny SendMessage and
    // mute the teammate entirely.
    expect(captured).toHaveLength(1);
    expect(captured[0].teammate).toBe(true);
    expect(captured[0].mode).toBe("default");
    expect(
      captured[0].check("SendMessage", "command", {
        to: "leader",
        content: "x",
      }).effect,
    ).toBe("allow");

    await vi.waitFor(() => {
      expect(mgr.hasLeaderNotifications()).toBe(true);
    });
    await mgr.deleteAll();
  });

  it("inherits live parent execution modes and maps parent plan to default", async () => {
    const project = cwd();
    const mgr = new TeamManager(project);
    mgr.create("squad");
    const parent = new PermissionChecker(project, "bypassPermissions");
    parent.mode = "plan";
    const captured: PermissionChecker[] = [];
    const tool = new AgentTool(project, new ToolRegistry(), () =>
      Promise.resolve("unused"),
    );
    tool.setTeamManager(mgr, (_registry, checker) => {
      if (checker) {
        captured.push(checker);
      }
      return () => Promise.resolve("done");
    });
    await tool.execute(
      { cwd: project, permissionChecker: parent },
      {
        kind: "teammate",
        fork: false,
        description: "w1",
        prompt: "task",
      },
    );
    try {
      expect(captured[0].mode).toBe("default");
      expect(
        captured[0].check("Bash", "command", { command: "pnpm test" }).effect,
      ).toBe("ask");
      parent.mode = "default";
      expect(
        captured[0].check("WriteFile", "write", { file_path: "a.ts" }).effect,
      ).toBe("ask");
      parent.mode = "acceptEdits";
      expect(
        captured[0].check("WriteFile", "write", { file_path: "a.ts" }).effect,
      ).toBe("allow");
      parent.mode = "plan";
      expect(captured[0].mode).toBe("default");
      expect(readTeamFile(project, "squad")?.permissionMode).toBe("plan");
    } finally {
      await mgr.deleteAll();
    }
  });

  it("SendMessage delivers plain text from a teammate to the leader mailbox", async () => {
    const mgr = new TeamManager(cwd());
    mgr.create("t2").addMember("w2");
    const tool = new SendMessageTool(mgr, "w2");

    expect(JSON.stringify(tool.schema().input_schema.properties.to)).toContain(
      "'leader'",
    );

    // The leader is not a registered member, so the plain-text path must route
    // to the dedicated leader mailbox instead of throwing "Member 'leader' not found".
    const send = await tool.execute(
      { cwd: cwd() },
      { to: "leader", content: "findings: X confirmed" },
    );
    expect(send.isError).toBe(false);
    expect(send.output).toContain("leader");

    // The report reaches the leader as a task notification in from=X: text form.
    expect(
      mgr
        .drainLeaderMailbox()
        .some((d) => d.includes('from="w2">findings: X confirmed')),
    ).toBe(true);

    const rejected = await tool.execute(
      { cwd: cwd() },
      { to: "Yukino", content: "misaddressed report" },
    );
    expect(rejected.isError).toBe(true);
    expect(mgr.drainLeaderMailbox()).toEqual([]);
  });

  it("rejects duplicate teammate reservations", () => {
    const mgr = new TeamManager(cwd());
    const team = mgr.create("squad");
    team.addMember("reviewer");
    expect(() => team.addMember("reviewer")).toThrow("already exists");
  });

  it("TeamCreate preserves existing teams, running members, tasks, and persisted teams", async () => {
    const project = cwd();
    const mgr = new TeamManager(project);

    await new TeamCreateTool(mgr).execute({ cwd: project }, {});
    const old = mgr.list()[0];
    old?.spawnTeammate("w1", "task A", (task: string) =>
      Promise.resolve(`done:${task}`),
    );
    await vi.waitFor(() => {
      expect(old?.getMember("w1")?.uiState?.status).toBe("idle");
    });

    new TeamManager(project).create("stale");
    mgr.getTaskStore(old.name).write({ todos: [{ subject: "existing work" }] });
    expect(listTeamNames(project)).toHaveLength(2);

    const result = await new TeamCreateTool(mgr).execute(
      { cwd: project },
      { description: "fresh work" },
    );
    const fresh = mgr.list()[1];
    expect(result.isError).toBe(false);
    expect(fresh?.name).not.toBe(old?.name);
    expect(fresh?.description).toBe("fresh work");
    expect(result.output).toContain(fresh?.name);
    expect(mgr.list()).toHaveLength(2);
    expect(listTeamNames(project).sort()).toEqual(
      [old.name, fresh.name, "stale"].sort(),
    );
    expect(old.getMember("w1")?.active).toBe(true);
    expect(mgr.getTaskStore(old.name).listTasks()[0]?.subject).toBe(
      "existing work",
    );
    await mgr.deleteAll();
  });

  it("TeamCreate accepts an explicit name and rejects duplicates", async () => {
    const project = cwd();
    const mgr = new TeamManager(project);
    const create = new TeamCreateTool(mgr);

    const named = await create.execute(
      { cwd: project },
      { name: "  Refactor Auth  ", description: "auth work" },
    );
    expect(named.isError).toBe(false);
    expect(named.output).toContain("Refactor Auth");
    expect(mgr.list()[0]?.name).toBe("Refactor Auth");
    expect(mgr.list()[0]?.description).toBe("auth work");
    expect(listTeamNames(project)).toEqual(["refactor-auth"]);

    const duplicate = await create.execute(
      { cwd: project },
      { name: "refactor-AUTH" },
    );
    expect(duplicate.isError).toBe(true);
    expect(duplicate.output).toContain("already exists");
    expect(mgr.list()).toHaveLength(1);

    // A name persisted by an earlier session is a duplicate too.
    const revived = await new TeamCreateTool(new TeamManager(project)).execute(
      { cwd: project },
      { name: "Refactor Auth" },
    );
    expect(revived.isError).toBe(true);
    expect(revived.output).toContain("already exists");

    const blank = await create.execute({ cwd: project }, { name: "   " });
    expect(blank.isError).toBe(false);
    expect(mgr.list()).toHaveLength(2);
    expect(mgr.list()[1]?.name).toMatch(/^team-[a-f0-9-]+$/);
    await mgr.deleteAll();
  });

  it("rejects persisted duplicate names without restoring members or releasing their work", async () => {
    const project = cwd();
    const original = new TeamManager(project);
    const team = original.create("Auth Work");
    const member = team.addMember("worker");
    member.active = true;
    team.persist();
    original.getTaskStore(team.name).write({
      todos: [
        { subject: "active work", status: "in_progress", owner: "worker" },
      ],
    });
    const path = teamConfigPath(project, team.name);
    const config = readFileSync(path, "utf8");
    const fresh = new TeamManager(project);
    const result = await new TeamCreateTool(fresh).execute(
      { cwd: project },
      { name: "auth-work" },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("already exists");
    expect(readFileSync(path, "utf8")).toBe(config);
    expect(original.getTaskStore(team.name).get("1")).toMatchObject({
      owner: "worker",
      status: "in_progress",
    });
    expect(team.leaderMailbox.receiveSync()).toEqual([]);
    expect(fresh.list()).toEqual([]);
  });

  it("preserves existing team data when its config cannot be parsed", async () => {
    const project = cwd();
    const original = new TeamManager(project);
    original.create("Auth Work");
    original
      .getTaskStore("Auth Work")
      .write({ todos: [{ subject: "saved work" }] });
    const path = teamConfigPath(project, "Auth Work");
    writeFileSync(path, "{broken config", "utf8");
    const fresh = new TeamManager(project);
    const result = await new TeamCreateTool(fresh).execute(
      { cwd: project },
      { name: "auth-work" },
    );

    expect(result.isError).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("{broken config");
    expect(original.getTaskStore("Auth Work").get("1")?.subject).toBe(
      "saved work",
    );
    expect(fresh.list()).toEqual([]);
  });

  it("creates and deletes the current team without name arguments", async () => {
    const project = cwd();
    const mgr = new TeamManager(project);
    const create = new TeamCreateTool(mgr);
    const list = new TeamListTool(mgr);
    const remove = new TeamDeleteTool(mgr);
    expect(create.schema().input_schema).toMatchObject({
      properties: {
        name: { type: "string" },
        description: { type: "string" },
      },
      required: [],
    });
    expect(create.schema().input_schema.properties).not.toHaveProperty(
      "team_name",
    );
    expect(list.name).toBe("TeamList");
    expect(remove.schema().input_schema.properties).toMatchObject({
      team_name: { type: "string" },
    });
    expect(remove.schema().input_schema.required).toEqual([]);
    expect((await list.execute()).output).toBe("No active team.");
    expect((await remove.execute()).isError).toBe(false);
    expect((await create.execute({ cwd: project }, {})).isError).toBe(false);
    expect(mgr.list()[0]?.name).toMatch(/^team-[a-f0-9-]+$/);
    const team = mgr.list()[0];
    team?.spawnTeammate("worker", "work", () => Promise.resolve("done"));
    const result = await remove.execute();
    expect(result.isError).toBe(false);
    expect(result.output).toContain(team?.name);
    expect(team?.getMember("worker")?.active).toBe(false);
    expect(mgr.list()).toEqual([]);
    expect(listTeamNames(project)).toEqual([]);
  });

  it("defaults to teammates and generates unique names in a single team", async () => {
    const project = cwd();
    const mgr = new TeamManager(project);
    const spawn = vi.fn(() => Promise.resolve("one-shot result"));
    const agent = new AgentTool(project, new ToolRegistry(), spawn);
    agent.setTeamManager(mgr, () => () => Promise.resolve("done"));
    try {
      const results = await Promise.all(
        ["reviewer", "reviewer", "leader"].map((description) =>
          agent.execute(
            { cwd: project },
            { description, prompt: "work", fork: false },
          ),
        ),
      );
      expect(results.every((result) => !result.isError)).toBe(true);
      expect(mgr.list()).toHaveLength(1);
      const team = mgr.list()[0];
      expect(team?.listMembers().map((member) => member.name)).toEqual([
        "reviewer",
        "reviewer-2",
        "leader-2",
      ]);
      expect(spawn).not.toHaveBeenCalled();
      const result = await agent.execute(
        { cwd: project },
        {
          kind: "subagent",
          description: "one-shot",
          prompt: "work",
          fork: false,
        },
      );
      expect(result).toMatchObject({
        output: "one-shot result",
        isError: false,
      });
      expect(team?.listMembers()).toHaveLength(3);
      expect(spawn).toHaveBeenCalledOnce();
    } finally {
      await mgr.deleteAll();
    }
  });

  it.each([
    { kind: "worker" },
    { kind: false },
    { worktree: "true" },
    { worktree: 1 },
  ])(
    "rejects invalid Agent parameters before spawning: %j",
    async (invalid) => {
      const project = cwd();
      const mgr = new TeamManager(project);
      const spawn = vi.fn(() => Promise.resolve("unused"));
      const factory = vi.fn(() => () => Promise.resolve("unused"));
      const agent = new AgentTool(project, new ToolRegistry(), spawn);
      agent.setTeamManager(mgr, factory);
      const result = await agent.execute(
        { cwd: project },
        {
          description: "worker",
          prompt: "work",
          fork: false,
          ...invalid,
        },
      );
      expect(result.isError).toBe(true);
      expect(mgr.list()).toEqual([]);
      expect(factory).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("requires an active team for messaging", async () => {
    const mgr = new TeamManager(cwd());
    const result = await new SendMessageTool(mgr).execute(
      { cwd: cwd() },
      { to: "a", content: "m" },
    );
    expect(result.isError).toBe(true);
  });
});
