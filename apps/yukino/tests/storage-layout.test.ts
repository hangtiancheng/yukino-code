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

import { FileHistory } from "@/file-history/index.js";
import { append, load } from "@/history/index.js";
import { createPlanPath } from "@/plan-file/index.js";
import {
  getSessionFilePath,
  listSessions,
  saveMessage,
} from "@/session/index.js";
import { getYukinoDir, projectKey } from "@/storage/paths.js";
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
      append("First prompt");
      append("Second prompt");
      expect(load()).toEqual(["First prompt", "Second prompt"]);
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
