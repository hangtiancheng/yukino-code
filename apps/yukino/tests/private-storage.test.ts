import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileHistory } from "@/file-history/index.js";
import * as history from "@/history/index.js";
import { closeLogger, initLogger } from "@/logger/index.js";
import { createPlanPath, savePlan } from "@/plan-file/index.js";
import { record } from "@/recover.js";
import {
  getSessionFilePath,
  loadSession,
  saveMessage,
  truncateSessionLines,
} from "@/session/index.js";
import { getYukinoDir, projectPath, yukinoPath } from "@/storage/index.js";
import {
  mkdirPrivateSync,
  openPrivateFileSync,
  readPrivateFileSync,
  writePrivateFile,
  writePrivateFileSync,
} from "@/storage/private.js";
import { TeamManager } from "@/teams/index.js";
import { persistLargeResult, spillDir } from "@/tool-result/index.js";
import { createShellOutputFile } from "@/tools/shell-background.js";
import { WriteFileTool } from "@/tools/write-file.js";

let previousUmask: number;
let directory: string;
beforeEach(() => {
  previousUmask = process.umask(0o022);
  directory = mkdtempSync(join(tmpdir(), "yukino-private-storage-"));
});
afterEach(() => {
  closeLogger();
  process.umask(previousUmask);
  rmSync(directory, { recursive: true, force: true });
});
const mode = (path: string) => statSync(path).mode & 0o777;

describe.skipIf(process.platform === "win32")(
  "private state permissions on POSIX",
  () => {
    it("protects new, existing, appended and atomically replaced files without changing HOME", async () => {
      const root = getYukinoDir();
      const home = dirname(root);
      const homeMode = mode(home);
      mkdirSync(join(root, "projects", "test"), {
        recursive: true,
        mode: 0o755,
      });
      const file = join(root, "projects", "test", "state.json");
      writeFileSync(file, "existing", { mode: 0o644 });
      expect(readPrivateFileSync(file, "utf8")).toBe("existing");
      expect(mode(file)).toBe(0o600);
      for (const dir of [root, join(root, "projects"), dirname(file)]) {
        expect(mode(dir)).toBe(0o700);
      }
      chmodSync(file, 0o644);
      writePrivateFileSync(file, " appended", { flag: "a" });
      expect(readFileSync(file, "utf8")).toBe("existing appended");
      expect(mode(file)).toBe(0o600);
      const temporary = `${file}.tmp`;
      writePrivateFileSync(temporary, "replacement");
      renameSync(temporary, file);
      expect(mode(file)).toBe(0o600);
      chmodSync(file, 0o644);
      await writePrivateFile(file, "async replacement");
      expect(mode(file)).toBe(0o600);
      expect(mode(home)).toBe(homeMode);
      expect(mode(directory)).toBe(0o700);
    });

    it("uses private state files across session, history, plans, logs, backups, teams, memory and shell output", async () => {
      saveMessage(directory, "private", {
        role: "user",
        content: "test",
        timestamp: 1,
      });
      saveMessage(directory, "private", {
        role: "assistant",
        content: "test",
        timestamp: 2,
      });
      truncateSessionLines(getSessionFilePath(directory, "private"), 1);
      history.append("prompt");
      const plan = { planFilePath: createPlanPath() };
      savePlan(plan, "plan");
      const logger = initLogger({
        sessionId: "private",
        mode: "terminal",
        skipCleanup: true,
      });
      logger.warn("diagnostic");
      closeLogger();
      record("synthetic diagnostic");
      const source = join(directory, "source.ts");
      writeFileSync(source, "original");
      const files = new FileHistory("private");
      files.trackEdit(source);
      files.makeSnapshot(0, "checkpoint");
      const manager = new TeamManager(directory);
      const team = manager.create("private");
      team.addMember("worker");
      await team.sendMessage("leader", "worker", "test");
      await manager.dispose();
      const memory = projectPath(directory, "memory", "topic.md");
      expect(
        (
          await new WriteFileTool().execute(
            { cwd: directory },
            { file_path: memory, content: "memory" },
          )
        ).isError,
      ).toBe(false);
      const output = createShellOutputFile("private");
      closeSync(output.fd);
      const inspect = (path: string) => {
        const info = lstatSync(path);
        expect(info.isSymbolicLink()).toBe(false);
        expect(mode(path), path).toBe(info.isDirectory() ? 0o700 : 0o600);
        if (info.isDirectory()) {
          for (const entry of readdirSync(path)) {
            inspect(join(path, entry));
          }
        }
      };
      inspect(getYukinoDir());
      expect(mode(source)).toBe(0o644);
    });

    it("tightens old transcript and log permissions on read or append", () => {
      const session = getSessionFilePath(directory, "existing");
      mkdirSync(dirname(session), { recursive: true, mode: 0o755 });
      writeFileSync(
        session,
        `${JSON.stringify({ role: "user", content: "test", timestamp: 1 })}\n`,
        { mode: 0o644 },
      );
      expect(loadSession(directory, "existing")).toHaveLength(1);
      expect(mode(session)).toBe(0o600);
      const log = yukinoPath("logs", "existing.jsonl");
      mkdirSync(dirname(log), { recursive: true, mode: 0o755 });
      writeFileSync(log, "", { mode: 0o644 });
      initLogger({
        sessionId: "existing",
        mode: "terminal",
        skipCleanup: true,
      }).warn("test");
      closeLogger();
      expect(mode(log)).toBe(0o600);
      expect(mode(dirname(log))).toBe(0o700);
    });

    it("refuses links into source files and leaves source contents and modes intact", () => {
      const source = join(directory, "source.ts");
      writeFileSync(source, "original", { mode: 0o644 });
      mkdirPrivateSync(yukinoPath("memory"));
      const link = yukinoPath("memory", "linked.md");
      symlinkSync(source, link);
      expect(() => {
        writePrivateFileSync(link, "changed");
      }).toThrow();
      expect(() => openPrivateFileSync(link, "r")).toThrow();
      const linkedDirectory = yukinoPath("memory", "linked-dir");
      symlinkSync(directory, linkedDirectory);
      expect(() => {
        writePrivateFileSync(join(linkedDirectory, "new.md"), "changed");
      }).toThrow();
      expect(existsSync(join(directory, "new.md"))).toBe(false);
      expect(readFileSync(source, "utf8")).toBe("original");
      expect(mode(source)).toBe(0o644);
      expect(mode(directory)).toBe(0o700);
    });

    it("encodes provider call IDs before spilling so they cannot target or chmod workspace files", () => {
      const source = join(directory, "source.txt");
      writeFileSync(source, "original", { mode: 0o644 });
      const id = relative(spillDir("private-spill"), source).slice(0, -4);
      const result = persistLargeResult("private-spill", id, "large result");
      expect(result).toContain("<persisted-output>");
      expect(readFileSync(source, "utf8")).toBe("original");
      expect(mode(source)).toBe(0o644);
      const saved = join(
        spillDir("private-spill"),
        `${encodeURIComponent(id)}.txt`,
      );
      expect(readFileSync(saved, "utf8")).toBe("large result");
      expect(mode(saved)).toBe(0o600);
    });

    it("preserves executable source permissions when restoring a private backup", () => {
      const source = join(directory, "script.sh");
      writeFileSync(source, "original", { mode: 0o755 });
      const files = new FileHistory("source-modes");
      files.trackEdit(source);
      files.makeSnapshot(0, "before");
      writeFileSync(source, "changed");
      files.makeSnapshot(1, "after");
      files.rewind(0);
      expect(readFileSync(source, "utf8")).toBe("original");
      expect(mode(source)).toBe(0o755);
    });
  },
);
