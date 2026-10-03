import { mkdtempSync as createTempDir, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PermissionChecker } from "@/permissions/index.js";
import { AgentTool } from "@/subagent/agent-tool.js";
import type * as teamBackend from "@/teams/backend.js";
import { TeamManager } from "@/teams/index.js";
import {
  createProgress,
  recordTokens,
  recordToolResult,
  recordToolStart,
  recordTurnComplete,
} from "@/teams/progress.js";
import { getNameRegistry } from "@/teams/registry.js";
import { listTeamNames, readTeamFile } from "@/teams/team-file.js";
import {
  ListTeamsTool,
  SendMessageTool,
  TeamCreateTool,
  TeamDeleteTool,
} from "@/teams/tools.js";
import { ToolRegistry } from "@/tools/registry.js";

const spawnTeammateMock = vi.hoisted(() =>
  vi.fn((_config: teamBackend.SpawnConfig) => ({
    cancel: vi.fn(),
    paneId: "test-pane",
  })),
);

vi.mock("@/teams/backend.js", async (importOriginal) => ({
  ...(await importOriginal<typeof teamBackend>()),
  spawnTeammate: spawnTeammateMock,
}));

// The teams directory lives at <home>/.yukino/teams, so the tests redirect the
// entire home directory to a temp dir to avoid leaving residue in the real
// ~/.yukino/teams. os.homedir() reads USERPROFILE on Windows and HOME on other
// platforms, so set both.
let realHome: string | undefined;
let realUserProfile: string | undefined;
let homeDir = "";
const workDirs = new Set<string>();
beforeEach(() => {
  spawnTeammateMock.mockClear();
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
  for (const directory of workDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
  workDirs.clear();
});
const workDir = () => {
  const directory = createTempDir(join(tmpdir(), "yukino-team-"));
  workDirs.add(directory);
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
  it("passes node a script entrypoint for external teammates", async () => {
    const project = workDir();
    const mgr = new TeamManager(project);
    const team = mgr.create("external-squad", "tmux");
    const entry = process.argv[1] ?? "src/main.tsx";

    team.spawnTeammate("external-scout", "find X", () =>
      Promise.resolve("unused"),
    );

    expect(spawnTeammateMock).toHaveBeenCalledOnce();
    const config = spawnTeammateMock.mock.calls[0]?.[0];
    expect(config?.command).toBe("node");
    expect(config?.args[0]).toBe(entry);
    expect(config?.args).not.toContain("run");
    expect(config?.args).not.toContain("--input-type=module");
    expect(readTeamFile(project, "external-squad")?.members[0]?.paneId).toBe(
      "test-pane",
    );

    await mgr.deleteAll();
  });

  it("persists terminal failure notifications from external teammates", async () => {
    const project = workDir();
    const mgr = new TeamManager(project);
    const team = mgr.create("external-failure", "tmux");
    team.spawnTeammate("external-scout", "find X", () =>
      Promise.resolve("unused"),
    );

    await team.leaderMailbox.send(
      "external-scout",
      "[idle] external-scout failed: boom",
    );
    mgr.drainLeaderMailbox();

    expect(team.getMember("external-scout")?.active).toBe(false);
    expect(team.getMember("external-scout")?.uiState?.status).toBe("failed");
    expect(getNameRegistry().resolve("external-scout")).toBeUndefined();
    expect(
      readTeamFile(project, "external-failure")?.members[0]?.isActive,
    ).toBe(false);
  });

  it("gives an external teammate the shutdown grace period before cancellation", async () => {
    vi.useFakeTimers();
    try {
      const mgr = new TeamManager(workDir());
      const team = mgr.create("graceful-stop", "tmux");
      team.spawnTeammate("external-scout", "find X", () =>
        Promise.resolve("unused"),
      );
      const cancel = team.getMember("external-scout")?.cancel;
      expect(cancel).toBeTypeOf("function");

      const stopping = team.stopMember("external-scout");
      await Promise.resolve();
      expect(cancel).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_499);
      expect(cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await stopping;

      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("spawnTeammate runs the task and posts its result to the leader mailbox", async () => {
    const mgr = new TeamManager(workDir());
    const team = mgr.create("squad");
    team.spawnTeammate(
      "scout",
      "find X",
      (task) => Promise.resolve(`did: ${task}`),
      undefined,
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
    const mgr = new TeamManager(workDir());
    mgr
      .create("squad")
      .spawnTeammate("flaky", "boom", () =>
        Promise.reject(new Error("kaboom")),
      );
    await vi.waitFor(() => {
      expect(mgr.get("squad")?.getMember("flaky")?.uiState?.status).toBe(
        "failed",
      );
    });
    expect(mgr.drainLeaderMailbox().some((d) => d.includes("failed"))).toBe(
      true,
    );
  });

  it("TaskStop aborts an active in-process teammate and waits for it to settle", async () => {
    const mgr = new TeamManager(workDir());
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
    const team = new TeamManager(workDir()).create("squad");
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
    const mgr = new TeamManager(workDir());

    expect(
      (
        await new TeamCreateTool(mgr).execute(
          {
            workDir: workDir(),
          },
          { team_name: "t1" },
        )
      ).output,
    ).toContain("created");

    mgr
      .get("t1")
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
        workDir: workDir(),
      },
      { to: "w1", content: "hi" },
    );
    expect(send.isError).toBe(false);
    expect(
      mgr
        .get("t1")
        ?.getMember("w1")
        ?.mailbox.receiveSync()
        .map((m) => m.text),
    ).toContain("hi");

    const list = await new ListTeamsTool(mgr).execute();
    expect(list.output).toContain("t1");
    expect(list.output).toContain("w1");
  });

  it("requires approval for mutating coordination tools", () => {
    const project = workDir();
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
    expect(new ListTeamsTool(mgr).category).toBe("read");
  });

  it("gives spawned teammates a coordination-capable checker", async () => {
    const project = workDir();
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
      { workDir: project },
      {
        team_name: "squad",
        name: "w1",
        description: "worker",
        prompt: "task A",
      },
    );
    expect(result.isError).toBe(false);

    // The teammate checker must exempt coordination tools: teammates have no
    // approval dialog, so an "ask" decision would auto-deny SendMessage and
    // mute the teammate entirely.
    expect(captured).toHaveLength(1);
    expect(captured[0].teammate).toBe(true);
    expect(captured[0].mode).toBe("acceptEdits");
    expect(
      captured[0].check("SendMessage", "command", {
        to: "leader",
        content: "x",
      }).effect,
    ).toBe("allow");

    await vi.waitFor(() => {
      expect(mgr.hasLeaderNotifications()).toBe(true);
    });
  });

  it("SendMessage delivers plain text from a teammate to the leader mailbox", async () => {
    const mgr = new TeamManager(workDir());
    mgr.create("t2").addMember("w2");
    const tool = new SendMessageTool(mgr, "w2");

    expect(JSON.stringify(tool.schema().input_schema.properties.to)).toContain(
      "'leader'",
    );

    // The leader is not a registered member, so the plain-text path must route
    // to the dedicated leader mailbox instead of throwing "Member 'leader' not found".
    const send = await tool.execute(
      { workDir: workDir() },
      { to: "leader", content: "findings: X confirmed" },
    );
    expect(send.isError).toBe(false);
    expect(send.output).toContain("leader");

    // The report reaches the leader as a task notification in from=X: text form.
    expect(
      mgr
        .drainLeaderMailbox()
        .some((d) => d.includes("from=w2: findings: X confirmed")),
    ).toBe(true);

    const rejected = await tool.execute(
      { workDir: workDir() },
      { to: "Yukino", content: "misaddressed report" },
    );
    expect(rejected.isError).toBe(true);
    expect(mgr.drainLeaderMailbox()).toEqual([]);
  });

  it("rejects duplicate teammate reservations", () => {
    const mgr = new TeamManager(workDir());
    const team = mgr.create("squad");
    team.addMember("reviewer");
    expect(() => team.addMember("reviewer")).toThrow("already exists");
  });

  it("TeamCreate sweeps other teams so at most one exists", async () => {
    const project = workDir();
    const mgr = new TeamManager(project);

    // A live team with a spawned teammate.
    await new TeamCreateTool(mgr).execute(
      { workDir: workDir() },
      { team_name: "old" },
    );
    mgr
      .get("old")
      ?.spawnTeammate("w1", "task A", (task: string) =>
        Promise.resolve(`done:${task}`),
      );
    await vi.waitFor(() => {
      expect(mgr.get("old")?.getMember("w1")?.uiState?.status).toBe("idle");
    });

    // A disk-only leftover from a previous session, unknown to this manager.
    new TeamManager(project).create("stale");
    expect(listTeamNames(project).sort()).toEqual(["old", "stale"]);

    const result = await new TeamCreateTool(mgr).execute(
      { workDir: workDir() },
      { team_name: "fresh" },
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("fresh");
    expect(mgr.list().map((team) => team.name)).toEqual(["fresh"]);
    expect(listTeamNames(project)).toEqual(["fresh"]);
  });

  it("validates required args", async () => {
    const mgr = new TeamManager(workDir());
    expect(
      (
        await new TeamCreateTool(mgr).execute(
          {
            workDir: workDir(),
          },
          {},
        )
      ).isError,
    ).toBe(true);
    expect(
      (
        await new SendMessageTool(mgr).execute(
          {
            workDir: workDir(),
          },
          { to: "a", content: "m" },
        )
      ).isError,
    ).toBe(true);
  });
});
