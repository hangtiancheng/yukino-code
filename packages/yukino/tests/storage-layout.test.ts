import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createCostLedger } from "@/cost/ledger.js";
import { FileHistory } from "@/file-history/index.js";
import { recordInput, loadInputTexts } from "@/history/index.js";
import { createPlanPath } from "@/plan-file/index.js";
import {
  getSessionFilePath,
  listSessions,
  saveMessage,
} from "@/session/index.js";
import { getYukinoDir, projectKey } from "@/storage/index.js";
import { TaskStore } from "@/todo/store.js";

describe("global storage", () => {
  it("keeps resume lists isolated by project while sharing prompt history", () => {
    const root = mkdtempSync(join(tmpdir(), "yukino-storage-projects-"));
    try {
      const first = join(root, "first");
      const second = join(root, "second");
      mkdirSync(first);
      mkdirSync(second);
      saveMessage(first, "first-session", {
        role: "user",
        content: "First",
        timestamp: 1,
      });
      saveMessage(second, "second-session", {
        role: "user",
        content: "Second",
        timestamp: 1,
      });
      expect(listSessions(first).map((session) => session.id)).toEqual([
        "first-session",
      ]);
      expect(listSessions(second).map((session) => session.id)).toEqual([
        "second-session",
      ]);
      expect(getSessionFilePath(first, "first-session")).toContain(
        getYukinoDir(),
      );
      recordInput({
        text: "First prompt",
        cwd: first,
        sessionId: "first-session",
        source: "cli",
      });
      recordInput({
        text: "Second prompt",
        cwd: second,
        sessionId: "second-session",
        source: "cli",
      });
      expect(loadInputTexts()).toEqual(["First prompt", "Second prompt"]);
      const firstLedger = createCostLedger({
        sessionId: "shared-name",
        cwd: first,
        persist: true,
      });
      const secondLedger = createCostLedger({
        sessionId: "shared-name",
        cwd: second,
        persist: true,
      });
      firstLedger.registerRun({ sessionId: "shared-name", runId: "first-run" });
      secondLedger.registerRun({
        sessionId: "shared-name",
        runId: "second-run",
      });
      expect(firstLedger.path).toContain(getYukinoDir());
      expect(secondLedger.path).toContain(getYukinoDir());
      expect(firstLedger.path).not.toBe(secondLedger.path);
      expect(firstLedger.getRuns().map((run) => run.runId)).toEqual([
        "first-run",
      ]);
      expect(secondLedger.getRuns().map((run) => run.runId)).toEqual([
        "second-run",
      ]);
      new FileHistory("first-session");
      new TaskStore("first-session").save([], 1);
      expect(createPlanPath()).toContain(getYukinoDir());
      expect(existsSync(join(first, ".yukino"))).toBe(false);
      expect(existsSync(join(second, ".yukino"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the same project namespace through a symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "yukino-storage-alias-"));
    try {
      const project = join(root, "project");
      const alias = join(root, "alias");
      mkdirSync(project);
      symlinkSync(project, alias, "dir");
      expect(projectKey(alias)).toBe(projectKey(project));
      expect(
        createCostLedger({
          sessionId: "alias-session",
          cwd: alias,
          persist: true,
        }).path,
      ).toBe(
        createCostLedger({
          sessionId: "alias-session",
          cwd: project,
          persist: true,
        }).path,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
