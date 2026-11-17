import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ACTIVITY_FILE_NAME,
  COMPACT_AFTER_RECORDS,
  MAX_HISTORY_ENTRIES,
} from "@/history/constants.js";
import {
  compactActivity,
  getCommandUsage,
  listProjects,
  loadInputs,
  loadInputTexts,
  recordInput,
  registerProject,
  type InputEntry,
} from "@/history/index.js";
import { getYukinoDir, projectKey, yukinoPath } from "@/storage/index.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return { ...original, renameSync: vi.fn(original.renameSync) };
});

function input(index: number, commandName: string | null = null): InputEntry {
  return {
    type: "input",
    id: randomUUID(),
    text: `prompt-${String(index)}`,
    timestamp: index,
    cwd: process.cwd(),
    sessionId: "session",
    source: "cli",
    commandName,
  };
}

describe("activity history", () => {
  it("retains duplicate input events while deduplicating consecutive display texts", () => {
    const first = recordInput({
      text: "continue",
      cwd: process.cwd(),
      sessionId: "one",
      source: "cli",
    });
    const second = recordInput({
      text: "continue",
      cwd: process.cwd(),
      sessionId: "two",
      source: "ws",
    });
    expect(first.id).not.toBe(second.id);
    expect(loadInputs().map((entry) => entry.sessionId)).toEqual([
      "one",
      "two",
    ]);
    expect(loadInputTexts()).toEqual(["continue"]);
    expect(listProjects()).toHaveLength(1);
    expect(listProjects()[0]).toMatchObject({
      projectKey: projectKey(process.cwd()),
      cwd: process.cwd(),
    });
  });

  it("bounds recall without losing cumulative command usage or projects during compaction", () => {
    registerProject(process.cwd());
    const project = listProjects()[0];
    const entries = Array.from(
      { length: MAX_HISTORY_ENTRIES + 2 },
      (_, index) => input(index, "help"),
    );
    appendFileSync(
      yukinoPath(ACTIVITY_FILE_NAME),
      entries.map((entry) => JSON.stringify(entry) + "\n").join(""),
    );
    expect(loadInputs()).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(loadInputs()[0].text).toBe("prompt-2");
    compactActivity();
    const lines = readFileSync(yukinoPath(ACTIVITY_FILE_NAME), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ type: "checkpoint" });
    expect(listProjects()).toEqual([project]);
    expect(getCommandUsage().help).toEqual({
      usageCount: MAX_HISTORY_ENTRIES + 2,
      lastUsedAt: MAX_HISTORY_ENTRIES + 1,
    });
    recordInput({
      text: "/help",
      cwd: process.cwd(),
      sessionId: null,
      source: "cli",
      commandName: "help",
    });
    expect(getCommandUsage().help.usageCount).toBe(MAX_HISTORY_ENTRIES + 3);
    compactActivity();
    expect(getCommandUsage().help.usageCount).toBe(MAX_HISTORY_ENTRIES + 3);
  });

  it("repairs an incomplete UTF-8 tail before appending and skips corrupt records", () => {
    recordInput({
      text: "first",
      cwd: process.cwd(),
      sessionId: "one",
      source: "cli",
    });
    appendFileSync(
      yukinoPath(ACTIVITY_FILE_NAME),
      'not-json\n{"type":"input","text":"未完成',
    );
    expect(loadInputTexts()).toEqual(["first"]);
    recordInput({
      text: "last",
      cwd: process.cwd(),
      sessionId: "one",
      source: "cli",
    });
    expect(loadInputTexts()).toEqual(["first", "last"]);
    expect(readFileSync(yukinoPath(ACTIVITY_FILE_NAME), "utf8")).not.toContain(
      "未完成",
    );
  });

  it.each([false, true])(
    "checkpoints without rejecting committed input when replacement fails=%s",
    (failReplacement) => {
      registerProject(process.cwd());
      const entry = input(1, "help");
      appendFileSync(
        yukinoPath(ACTIVITY_FILE_NAME),
        Array.from(
          { length: COMPACT_AFTER_RECORDS - 2 },
          (_, index) =>
            JSON.stringify({ ...entry, id: randomUUID(), timestamp: index }) +
            "\n",
        ).join(""),
      );
      if (failReplacement) {
        vi.mocked(fs.renameSync).mockImplementationOnce(() => {
          throw new Error("checkpoint replacement unavailable");
        });
      }
      expect(() =>
        recordInput({
          text: "last",
          cwd: process.cwd(),
          sessionId: "one",
          source: "cli",
        }),
      ).not.toThrow();
      expect(
        readFileSync(yukinoPath(ACTIVITY_FILE_NAME), "utf8").trim().split("\n"),
      ).toHaveLength(failReplacement ? COMPACT_AFTER_RECORDS : 1);
      expect(getCommandUsage().help.usageCount).toBe(COMPACT_AFTER_RECORDS - 2);
      compactActivity();
      expect(getCommandUsage().help.usageCount).toBe(COMPACT_AFTER_RECORDS - 2);
    },
  );

  it("canonicalizes aliases and registers projects even without submitted input", () => {
    const root = dirname(getYukinoDir());
    const project = join(root, "project");
    const alias = join(root, "alias");
    mkdirSync(project);
    symlinkSync(project, alias, "dir");
    registerProject(alias);
    registerProject(project);
    expect(listProjects()).toHaveLength(1);
    expect(listProjects()[0].cwd).toBe(realpathSync(project));
    expect(loadInputs()).toEqual([]);
    expect(statSync(yukinoPath(ACTIVITY_FILE_NAME)).mode & 0o777).toBe(0o600);
  });

  it("ignores mismatched project registrations without hiding valid projects", () => {
    registerProject(process.cwd());
    appendFileSync(
      yukinoPath(ACTIVITY_FILE_NAME),
      JSON.stringify({
        type: "project",
        cwd: "/wrong",
        projectKey: "0".repeat(64),
        createdAt: 1,
      }) + "\n",
    );
    expect(listProjects()).toHaveLength(1);
  });

  it("preserves updates from concurrent processes while compacting", async () => {
    registerProject(process.cwd());
    const home = dirname(getYukinoDir());
    const source = `import { recordInput, compactActivity } from './src/history/index.ts'; for (let i = 0; i < 20; i++) { recordInput({ text: '/help', cwd: process.cwd(), sessionId: null, source: 'sdk', commandName: 'help' }); if (i % 7 === 0) compactActivity(); }`;
    const run = () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", source],
          {
            cwd: process.cwd(),
            env: { ...process.env, HOME: home },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(stderr));
          }
        });
      });
    await Promise.all([run(), run(), run()]);
    expect(getCommandUsage().help.usageCount).toBe(60);
    expect(loadInputs()).toHaveLength(60);
  });
});
