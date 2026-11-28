import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessionMaintenanceCommand } from "@/session/maintenance-command.js";
import { SessionManager } from "@/session/manager.js";
import {
  parseSessionResumeCommand,
  requestSessionRestoration,
} from "@/session/resume.js";
import type { Asker } from "@/tools/ask-user.js";

let root: string;
let cwd: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yukino-session-host-"));
  cwd = join(root, "current");
  mkdirSync(cwd);
  vi.stubEnv("HOME", root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const accept: Asker = (questions) =>
  Promise.resolve(
    Object.fromEntries(
      questions.map((question) => [
        question.question,
        question.options[0].label,
      ]),
    ),
  );
const cancel: Asker = (questions) =>
  Promise.resolve(
    Object.fromEntries(
      questions.map((question) => [question.question, "cancel"]),
    ),
  );

describe("shared session host actions", () => {
  it("parses bounded picker filters and explicit JSON targets with Unicode and spaces", () => {
    expect(parseSessionResumeCommand("--all --archived name:编程")).toEqual({
      action: "picker",
      allProjects: true,
      includeArchived: true,
      query: "name:编程",
    });
    const path = join(root, "space 项目");
    expect(
      parseSessionResumeCommand(
        JSON.stringify({
          id: "saved",
          cwd: path,
          destination: cwd,
          copy: true,
        }),
      ),
    ).toMatchObject({ action: "resume", target: { cwd: path, copy: true } });
    expect(() =>
      parseSessionResumeCommand('{"id":"saved","confirmed":true}'),
    ).toThrow();
    expect(() => parseSessionResumeCommand("--unknown")).toThrow();
  });

  it("does not ask for cross-project confirmation for an alias of the current canonical project", async () => {
    const manager = SessionManager.create(cwd);
    const alias = join(root, "alias");
    symlinkSync(cwd, alias, "dir");
    const ask = vi.fn<Asker>(accept);
    const plan = await requestSessionRestoration(manager, alias, ask);
    expect(plan?.copy).toBe(false);
    expect(plan?.destination).toBe(manager.cwd);
    expect(ask).not.toHaveBeenCalled();
  });

  it("cancels cross-project restore without changing either source or active session", async () => {
    const other = join(root, "other");
    mkdirSync(other);
    const source = SessionManager.create(other);
    const revision = source.revision;
    expect(await requestSessionRestoration(source, cwd, cancel)).toBeNull();
    expect(source.revision).toBe(revision);
    expect(SessionManager.open(other, source.id).revision).toBe(revision);
  });

  it("offers an explicit revision-bound copy when the original directory is missing", async () => {
    const missing = join(root, "gone");
    mkdirSync(missing);
    const source = SessionManager.create(missing);
    source.append({
      role: "user",
      content: "harmless historical input",
      timestamp: 1,
    });
    rmdirSync(missing);
    const plan = await requestSessionRestoration(source, cwd, accept);
    expect(plan?.copy).toBe(true);
    expect(plan?.sourceMissing).toBe(true);
    expect(SessionManager.open(missing, source.id).getEntries()).toHaveLength(
      1,
    );
    const copied = await SessionManager.importStream(
      plan?.destination ?? "",
      source.exportStream({ scope: "tree", format: "jsonl" }),
    );
    expect(copied.id).not.toBe(source.id);
    expect(copied.cwd).not.toBe(source.cwd);
    expect(SessionManager.open(missing, source.id).getEntries()).toHaveLength(
      1,
    );
  });

  it("rejects a source changed during a restoration confirmation", async () => {
    const other = join(root, "other");
    mkdirSync(other);
    const source = SessionManager.create(other);
    const ask: Asker = async (questions, signal) => {
      source.setName("concurrent rename");
      return accept(questions, signal);
    };
    await expect(requestSessionRestoration(source, cwd, ask)).rejects.toThrow(
      "revision",
    );
  });

  it("archives and restores archive state without losing names or tags", async () => {
    const manager = SessionManager.create(cwd);
    manager.setMetadata({ name: "keep", tags: ["work"] });
    await sessionMaintenanceCommand("archive", "", manager, accept);
    expect(manager.getMetadata()).toEqual({
      name: "keep",
      tags: ["work"],
      archived: true,
    });
    await sessionMaintenanceCommand("unarchive", "", manager, accept);
    expect(manager.getMetadata()).toEqual({
      name: "keep",
      tags: ["work"],
      archived: false,
    });
  });

  it("only previews maintenance and cancellation preserves owned storage", async () => {
    const manager = SessionManager.create(cwd);
    const preview = await sessionMaintenanceCommand(
      "maintenance",
      "preview",
      manager,
      accept,
    );
    expect(preview).toContain("Owned paths:");
    expect(preview).toContain("no automatic cleanup");
    expect(
      await sessionMaintenanceCommand(
        "maintenance",
        "cleanup",
        manager,
        cancel,
      ),
    ).toContain("canceled");
    expect(SessionManager.open(cwd, manager.id).revision).toBe(
      manager.revision,
    );
    await expect(
      sessionMaintenanceCommand("maintenance", "delete", manager, accept),
    ).rejects.toThrow("Switch away");
  });
});
