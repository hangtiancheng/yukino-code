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

import { describe, it, expect, beforeEach, afterEach } from "vitest";

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

// The teams directory lives at <home>/.yukino/teams, so the tests redirect the
// entire home directory to a temp dir to avoid leaving residue in the real
// ~/.yukino/teams. os.homedir() reads USERPROFILE on Windows and HOME on other
// platforms, so set both.
let realHome: string | undefined;
let realUserProfile: string | undefined;
beforeEach(() => {
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
  it("spawnTeammate runs the task and posts its result to the lead mailbox", async () => {
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
    const drained = mgr.drainLeads();
    // The teammate sends an [idle] notification with its name after finishing
    expect(
      drained.some((d) => d.includes("scout") && d.includes("[idle]")),
    ).toBe(true);
    // Drained messages are consumed.
    expect(mgr.drainLeads()).toEqual([]);
  });

  it("a failing teammate reports the error to the lead", async () => {
    const mgr = new TeamManager(workDir());
    // eslint-disable-next-line @typescript-eslint/require-await
    mgr.create("squad").spawnTeammate("flaky", "boom", async () => {
      throw new Error("kaboom");
    });
    await wait(200);
    expect(mgr.drainLeads().some((d) => d.includes("failed"))).toBe(true);
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
      mgr.drainLeads().some((message) => message.includes("reason: stopped")),
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

    // eslint-disable-next-line @typescript-eslint/require-await
    const spawn = new SpawnTeammateTool(mgr, async (task) => `done:${task}`);
    const r = await spawn.execute(
      {
        workDir: workDir(),
      },
      { team: "t1", name: "w1", task: "task A" },
    );
    expect(r.isError).toBe(false);
    await wait(200);
    expect(
      mgr.drainLeads().some((d) => d.includes("w1") && d.includes("[idle]")),
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

  it("SendMessage delivers plain text from a teammate to the lead mailbox", async () => {
    const mgr = new TeamManager(workDir());
    mgr.create("t2").addMember("w2");

    // The lead is not a registered member, so the plain-text path must route
    // to the dedicated lead mailbox instead of throwing "Member 'lead' not found".
    const send = await new SendMessageTool(mgr, "w2").execute(
      { workDir: workDir() },
      { to: "lead", content: "findings: X confirmed" },
    );
    expect(send.isError).toBe(false);
    expect(send.output).toContain("lead");

    // The report reaches the lead as a task notification in from=X: text form.
    expect(
      mgr
        .drainLeads()
        .some((d) => d.includes("from=w2: findings: X confirmed")),
    ).toBe(true);
  });

  it("TeamCreate sweeps other teams so at most one exists", async () => {
    const mgr = new TeamManager(workDir());

    // A live team with a spawned teammate.
    await new TeamCreateTool(mgr).execute(
      { workDir: workDir() },
      { team_name: "old" },
    );
    const spawn = new SpawnTeammateTool(
      mgr,
      // eslint-disable-next-line @typescript-eslint/require-await
      async (task) => `done:${task}`,
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
        await new SpawnTeammateTool(
          mgr,
          // eslint-disable-next-line @typescript-eslint/require-await
          async () => "x",
        ).execute(
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
