import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, beforeEach, afterEach } from "vitest";

import { TeamManager } from "@/teams/index.js";
import { getNameRegistry } from "@/teams/registry.js";
import {
  readTeamFile,
  teamConfigPath,
  teamDir,
  teamsBaseDir,
} from "@/teams/team-file.js";

// The teams directory lives at <home>/.yukino/teams, so redirect the entire
// home directory to a temp dir to avoid leaving residue in the real
// ~/.yukino/teams. os.homedir() reads USERPROFILE on Windows and HOME on other
// platforms, so set both.
let origHome: string | undefined;
let origUserProfile: string | undefined;

beforeEach(() => {
  getNameRegistry().clear();
  origHome = process.env.HOME;
  origUserProfile = process.env.USERPROFILE;
  const tmp = mkdtempSync(join(tmpdir(), "yukino-home-"));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
});

afterEach(() => {
  getNameRegistry().clear();
  if (origHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = origHome;
  }
  if (origUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = origUserProfile;
  }
});

const workDir = () => mkdtempSync(join(tmpdir(), "yukino-work-"));

describe("team config persistence", () => {
  test("can be read back by a fresh TeamManager after writing to disk", () => {
    const project = workDir();
    const mgr = new TeamManager(project);
    const team = mgr.create("Refactor Auth", "in-process", {
      leaderAgentId: "leader",
      description: "Refactor the authentication module",
    });
    team.addMember("alice");
    team.setMemberMeta("alice", {
      agentType: "worker",
      model: "deepseek-flash",
      worktreePath: "/tmp/wt/alice",
    });

    // Swap in a brand-new manager to simulate a teammate process or the next session
    const fresh = new TeamManager(project);
    const got = fresh.get("Refactor Auth");

    expect(got).toBeDefined();
    expect(got?.leaderAgentId).toBe("leader");
    expect(got?.description).toBe("Refactor the authentication module");

    const m = got?.getMember("alice");
    expect(m).toBeDefined();
    expect(m?.agentType).toBe("worker");
    expect(m?.model).toBe("deepseek-flash");
    expect(m?.worktreePath).toBe("/tmp/wt/alice");
  });

  test("merges members from concurrent leader snapshots", () => {
    const project = workDir();
    const firstTeam = new TeamManager(project).create(
      "shared-roster",
      "in-process",
    );
    const secondTeam = new TeamManager(project).get("shared-roster");
    expect(secondTeam).toBeDefined();

    firstTeam.addMember("alice");
    secondTeam?.addMember("bob");

    expect(
      readTeamFile(project, "shared-roster")
        ?.members.map((member) => member.name)
        .sort(),
    ).toEqual(["alice", "bob"]);
  });

  test("uses the disk slug as identity while preserving the display name", () => {
    const project = workDir();
    const manager = new TeamManager(project);
    const displayTeam = manager.create("Refactor Auth", "in-process");

    expect(manager.get("refactor-auth")).toBe(displayTeam);
    expect(manager.create("refactor-auth", "in-process")).toBe(displayTeam);
    expect(manager.list()).toEqual([displayTeam]);
    expect(displayTeam.name).toBe("Refactor Auth");

    const restored = new TeamManager(project);
    const bySlug = restored.get("refactor-auth");
    expect(bySlug?.name).toBe("Refactor Auth");
    expect(restored.get("Refactor Auth")).toBe(bySlug);
    expect(restored.list()).toHaveLength(1);
  });

  test("isolates restore, lookup, tasks, and deletion by project", async () => {
    const firstProject = workDir();
    const secondProject = workDir();
    const first = new TeamManager(firstProject);
    first.create("Shared Team", "in-process").addMember("alice");
    first.getTaskStore("Shared Team").create("first project task");

    const second = new TeamManager(secondProject);
    second.restoreFromDisk();
    expect(second.list()).toEqual([]);
    expect(second.get("shared-team")).toBeUndefined();
    expect(second.getTaskStore("Shared Team").listTasks()).toEqual([]);

    second.create("Shared Team", "in-process").addMember("bob");
    second.getTaskStore("shared-team").create("second project task");
    expect(first.getTaskStore("shared-team").listTasks()).toHaveLength(1);
    expect(first.getTaskStore("shared-team").listTasks()[0]?.title).toBe(
      "first project task",
    );

    await second.deleteAll();

    const restoredFirst = new TeamManager(firstProject);
    restoredFirst.restoreFromDisk();
    expect(restoredFirst.list().map((team) => team.name)).toEqual([
      "Shared Team",
    ]);
    expect(
      restoredFirst.getTaskStore("shared-team").listTasks()[0]?.title,
    ).toBe("first project task");
    expect(existsSync(teamDir(firstProject, "Shared Team"))).toBe(true);
    expect(existsSync(teamDir(secondProject, "Shared Team"))).toBe(false);
  });

  test("teammate hydration is byte-identical and restores active runtime state", () => {
    const project = workDir();
    const leader = new TeamManager(project);
    const team = leader.create("restored", "tmux", {
      leaderAgentId: "leader",
    });
    const member = team.addMember("alice");
    member.active = true;
    member.backendType = "tmux";
    member.paneId = "yukino-persisted-pane";
    team.persist();
    const path = teamConfigPath(project, "restored");
    const before = readFileSync(path);

    getNameRegistry().clear();
    const teammate = new TeamManager(project, { claimLeadership: false });
    const restored = teammate.get("restored")?.getMember("alice");

    expect(readFileSync(path)).toEqual(before);
    expect(restored?.active).toBe(true);
    expect(restored?.uiState?.status).toBe("running");
    expect(restored?.external).toBe(true);
    expect(restored?.cancel).toBeTypeOf("function");
    expect(restored?.paneId).toBe("yukino-persisted-pane");
    expect(getNameRegistry().resolve("alice")).toBe("alice");
  });

  test("restores active iTerm members without inventing a cancel handle", () => {
    const project = workDir();
    const leader = new TeamManager(project);
    const team = leader.create("iterm-restored", "iterm");
    const member = team.addMember("bob");
    member.active = true;
    member.backendType = "iterm";
    team.persist();

    const restored = new TeamManager(project, {
      claimLeadership: false,
    })
      .get("iterm-restored")
      ?.getMember("bob");

    expect(restored?.uiState?.status).toBe("running");
    expect(restored?.external).toBe(true);
    expect(restored?.cancel).toBeUndefined();
  });

  test("does not resurrect in-process members after their process exits", () => {
    const project = workDir();
    const leader = new TeamManager(project);
    const team = leader.create("in-process-restored", "in-process");
    const member = team.addMember("carol");
    member.active = true;
    member.backendType = "in-process";
    team.persist();

    const restored = new TeamManager(project).get("in-process-restored");

    expect(restored?.getMember("carol")?.active).toBe(false);
    expect(restored?.getMember("carol")?.uiState).toBeUndefined();
    expect(
      readTeamFile(project, "in-process-restored")?.members[0]?.isActive,
    ).toBe(false);
  });

  test("slugifies the team directory name", () => {
    const project = workDir();
    const mgr = new TeamManager(project);
    mgr.create("Refactor Auth!", "tmux", { leaderAgentId: "leader" });

    const expected = join(
      teamsBaseDir(project),
      "refactor-auth-",
      "config.json",
    );
    expect(existsSync(expected)).toBe(true);
  });

  test("tearing down a team removes the entire team directory", async () => {
    const project = workDir();
    const mgr = new TeamManager(project);
    mgr.create("gone", "in-process", { leaderAgentId: "leader" });
    expect(existsSync(teamDir(project, "gone"))).toBe(true);

    await mgr.delete("gone");
    expect(existsSync(teamDir(project, "gone"))).toBe(false);
    expect(new TeamManager(project).get("gone")).toBeUndefined();
  });

  test("returns undefined for a team that does not exist", () => {
    expect(new TeamManager(workDir()).get("never-existed")).toBeUndefined();
  });

  test("persists a member's active state into the config", async () => {
    const project = workDir();
    const mgr = new TeamManager(project);
    const team = mgr.create("t", "in-process", { leaderAgentId: "leader" });
    team.addMember("bob");
    await team.stopMember("bob");

    const tf = readTeamFile(project, "t");
    expect(tf).not.toBeNull();
    expect(tf?.members).toHaveLength(1);
    expect(tf?.members[0]?.isActive).toBe(false);
  });

  test("persists inactive transitions on in-process completion and stopAll", async () => {
    const project = workDir();
    const manager = new TeamManager(project);
    const completedTeam = manager.create("completed", "in-process");
    completedTeam.spawnTeammate("failed", "task", () =>
      Promise.reject(new Error("done")),
    );
    await completedTeam.getMember("failed")?.done;
    expect(readTeamFile(project, "completed")?.members[0]?.isActive).toBe(
      false,
    );

    const stoppedTeam = manager.create("stopped", "in-process");
    const first = stoppedTeam.addMember("first");
    first.active = true;
    first.done = Promise.resolve();
    const second = stoppedTeam.addMember("second");
    second.active = true;
    second.done = Promise.resolve();
    stoppedTeam.persist();

    await stoppedTeam.stopAll();

    expect(
      readTeamFile(project, "stopped")?.members.map((entry) => entry.isActive),
    ).toEqual([false, false]);
  });

  test("publishes only parse-safe atomic config files", async () => {
    const project = workDir();
    const manager = new TeamManager(project);
    const team = manager.create("atomic", "in-process");
    const path = teamConfigPath(project, "atomic");
    const stopPath = join(teamsBaseDir(project), "atomic-reader-stop");
    const reader = spawn(
      process.execPath,
      [
        "-e",
        [
          "const fs = require('node:fs');",
          "const [path, stop] = process.argv.slice(1);",
          "process.stdout.write('ready\\n');",
          "while (!fs.existsSync(stop)) {",
          "  try { JSON.parse(fs.readFileSync(path, 'utf8')); }",
          "  catch (err) { process.stdout.write(`invalid:${String(err)}\\n`); break; }",
          "}",
        ].join("\n"),
        path,
        stopPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    reader.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const closed = new Promise<void>((resolve, reject) => {
      reader.once("error", reject);
      reader.once("close", () => {
        resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      reader.once("error", reject);
      const onData = (chunk: Buffer) => {
        if (chunk.toString().includes("ready")) {
          reader.stdout.off("data", onData);
          resolve();
        }
      };
      reader.stdout.on("data", onData);
    });

    for (let index = 0; index < 30; index++) {
      team.description = `${String(index)}:${"x".repeat(256 * 1024)}`;
      team.persist();
    }
    writeFileSync(stopPath, "stop");
    await closed;

    expect(output).not.toContain("invalid:");
    expect(readTeamFile(project, "atomic")?.description).toBe(team.description);
  });
});
