/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as teamBackend from "@/teams/backend.js";
import { TeamManager } from "@/teams/index.js";
import {
  createProgress,
  recordTokens,
  recordToolResult,
  recordToolStart,
  recordTurnComplete,
} from "@/teams/progress.js";
import { listTeamNames } from "@/teams/team-file.js";
import {
  TeamCreateTool,
  SpawnTeammateTool,
  SendMessageTool,
  ListTeamsTool,
} from "@/teams/tools.js";

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
beforeEach(() => {
  spawnTeammateMock.mockClear();
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  const tmp = mkdtempSync(join(tmpdir(), "yukino-home-"));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
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
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const workDir = () => mkdtempSync(join(tmpdir(), "yukino-team-"));

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
    const mgr = new TeamManager(workDir());
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

    await mgr.deleteAll();
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

    await wait(200);
    expect(mgr.hasLeaderNotifications()).toBe(true);
    const drained = mgr.drainLeaderMailbox();
    // The teammate sends an [idle] notification with its name after finishing
    expect(
      drained.some((d) => d.includes("scout") && d.includes("[idle]")),
    ).toBe(true);
    // Drained messages are consumed.
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
    await wait(200);
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

    const spawn = new SpawnTeammateTool(mgr, (task) =>
      Promise.resolve(`done:${task}`),
    );
    const r = await spawn.execute(
      {
        workDir: workDir(),
      },
      { team: "t1", name: "w1", task: "task A" },
    );
    expect(r.isError).toBe(false);
    await wait(200);
    expect(
      mgr
        .drainLeaderMailbox()
        .some((d) => d.includes("w1") && d.includes("[idle]")),
    ).toBe(true);

    // SendMessage to an existing member lands in that member's mailbox.
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

  it("rejects invalid, reserved, and duplicate explicit teammate names", async () => {
    const mgr = new TeamManager(workDir());
    const spawn = new SpawnTeammateTool(mgr, () => Promise.resolve("done"));

    for (const name of ["api/reviewer", "leader"]) {
      const result = await spawn.execute(
        { workDir: workDir() },
        { team: "squad", name, task: "inspect" },
      );
      expect(result.isError).toBe(true);
    }
    expect(mgr.list()).toEqual([]);

    const first = await spawn.execute(
      { workDir: workDir() },
      { team: "squad", name: "reviewer", task: "inspect" },
    );
    const duplicate = await spawn.execute(
      { workDir: workDir() },
      { team: "squad", name: "reviewer", task: "inspect again" },
    );
    expect(first.isError).toBe(false);
    expect(duplicate.isError).toBe(true);
    expect(duplicate.output).toContain("already exists");

    await mgr.stopAll();
  });

  it("TeamCreate sweeps other teams so at most one exists", async () => {
    const mgr = new TeamManager(workDir());

    // A live team with a spawned teammate.
    await new TeamCreateTool(mgr).execute(
      { workDir: workDir() },
      { team_name: "old" },
    );
    const spawn = new SpawnTeammateTool(mgr, (task) =>
      Promise.resolve(`done:${task}`),
    );
    await spawn.execute(
      { workDir: workDir() },
      { team: "old", name: "w1", task: "task A" },
    );
    await wait(200);

    // A disk-only leftover from a previous session, unknown to this manager.
    new TeamManager(workDir()).create("stale");
    expect(listTeamNames().sort()).toEqual(["old", "stale"]);

    const result = await new TeamCreateTool(mgr).execute(
      { workDir: workDir() },
      { team_name: "fresh" },
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("fresh");
    // Exactly one team remains — in memory and on disk.
    expect(mgr.list().map((team) => team.name)).toEqual(["fresh"]);
    expect(listTeamNames()).toEqual(["fresh"]);
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
        await new SpawnTeammateTool(mgr, () => Promise.resolve("x")).execute(
          {
            workDir: workDir(),
          },
          { team: "t" },
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
