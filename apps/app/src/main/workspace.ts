import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { watch, realpathSync, type FSWatcher } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { Tools } from "@yukino.js/yukino";

import type {
  FileEntry,
  FileSnapshot,
  WorkspaceSnapshot,
} from "../shared/workspace-types";

const exec = promisify(execFile);
const ignored = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  ".next",
  "coverage",
  ".turbo",
]);
const maxBytes = 2 * 1024 * 1024;
const revision = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

export class Workspace {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private baselines = new Map<string, string>();
  private changed = new Set<string>();

  readonly cwd: string;
  constructor(
    cwd: string,
    private readonly onChange: (path: string | null) => void,
    private readonly beforeWrite?: (path: string) => void,
  ) {
    this.cwd = realpathSync(cwd);
  }

  start(): void {
    try {
      this.watcher = watch(
        this.cwd,
        { recursive: true },
        (_event, filename) => {
          if (
            !filename ||
            filename.split(/[\\/]/u).some((part) => ignored.has(part))
          ) {
            return;
          }
          const path = filename.replaceAll("\\", "/");
          this.changed.add(path);
          if (this.timer) {
            clearTimeout(this.timer);
          }
          this.timer = setTimeout(() => {
            this.onChange(path);
          }, 180);
        },
      );
      this.watcher.on("error", () => {
        this.onChange(null);
      });
    } catch {
      this.onChange(null);
    }
  }

  private async safePath(path: string): Promise<string> {
    if (typeof path !== "string" || path.includes("\0")) {
      throw new Error("Invalid file path");
    }
    const root = await realpath(this.cwd);
    const requested = resolve(root, path);
    const lexical = relative(root, requested);
    if (
      lexical === ".." ||
      lexical.startsWith(`..${sep}`) ||
      isAbsolute(lexical)
    ) {
      throw new Error("Files must be inside the current project");
    }
    let target: string;
    try {
      target = await realpath(requested);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      target = resolve(
        await realpath(dirname(requested)),
        requested.slice(dirname(requested).length + 1),
      );
    }
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("Files must be inside the current project");
    }
    return target;
  }

  async list(path = ""): Promise<FileEntry[]> {
    const target = await this.safePath(path);
    const entries = await readdir(target, { withFileTypes: true });
    return entries
      .filter((entry) => !ignored.has(entry.name) && !entry.isSymbolicLink())
      .map((entry) => ({
        path: relative(this.cwd, resolve(target, entry.name)).replaceAll(
          "\\",
          "/",
        ),
        name: entry.name,
        directory: entry.isDirectory(),
      }))
      .sort(
        (a, b) =>
          Number(b.directory) - Number(a.directory) ||
          a.name.localeCompare(b.name),
      );
  }

  async capture(path: string): Promise<void> {
    try {
      const target = await this.safePath(path);
      const key = relative(this.cwd, target).replaceAll("\\", "/");
      if (!this.baselines.has(key)) {
        this.baselines.set(key, (await this.read(key)).content);
      }
    } catch {
      const key = relative(this.cwd, resolve(this.cwd, path)).replaceAll(
        "\\",
        "/",
      );
      if (
        !key.startsWith("../") &&
        !isAbsolute(key) &&
        !this.baselines.has(key)
      ) {
        this.baselines.set(key, "");
      }
    }
  }

  async read(path: string): Promise<FileSnapshot> {
    const target = await this.safePath(path);
    let deleted = false;
    const info = await stat(target).catch((error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        deleted = true;
        return null;
      }
      throw error;
    });
    if (info && !info.isFile()) {
      throw new Error("Select a file");
    }
    if (info && info.size > maxBytes) {
      throw new Error("The file exceeds 2 MB. Open it in an external editor.");
    }
    const bytes = deleted ? Buffer.from("") : await readFile(target);
    if (bytes.includes(0)) {
      throw new Error("This file is binary and cannot be edited as text");
    }
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const key = relative(this.cwd, target).replaceAll("\\", "/");
    let baseline = this.baselines.get(key);
    if (baseline === undefined) {
      try {
        const { stdout: prefix } = await exec(
          "git",
          ["rev-parse", "--show-prefix"],
          { cwd: this.cwd },
        );
        const { stdout } = await exec(
          "git",
          ["show", `HEAD:${prefix.trim()}${key}`],
          { cwd: this.cwd, maxBuffer: maxBytes },
        );
        baseline = stdout;
      } catch {
        if (deleted) {
          throw new Error("The file no longer exists");
        }
        baseline = content;
      }
    }
    if (!this.baselines.has(key)) {
      this.baselines.set(key, baseline);
    }
    return {
      path: key,
      content,
      baseline,
      revision: deleted ? "missing" : revision(content),
      deleted,
    };
  }

  async save(
    path: string,
    content: string,
    expectedRevision: string,
  ): Promise<FileSnapshot> {
    if (typeof content !== "string" || Buffer.byteLength(content) > maxBytes) {
      throw new Error("File contents exceed 2 MB");
    }
    const target = await this.safePath(path);
    return Tools.FileMutationQueue.withFileMutationQueue(target, async () => {
      const current = await this.read(path);
      if (current.deleted) {
        throw new Error(
          "The file was deleted. Choose another file from the file tree.",
        );
      }
      if (current.revision !== expectedRevision) {
        throw new Error(
          "The file was modified by the agent or another program. Review the disk version before saving.",
        );
      }
      if (!this.baselines.has(current.path)) {
        this.baselines.set(current.path, current.baseline);
      }
      this.beforeWrite?.(target);
      await Tools.AtomicWrite.writeFileAtomically(target, content);
      this.changed.add(current.path);
      this.onChange(current.path);
      return this.read(path);
    });
  }

  async snapshot(): Promise<WorkspaceSnapshot> {
    try {
      const [{ stdout }, { stdout: branch }, { stdout: prefix }] =
        await Promise.all([
          exec(
            "git",
            [
              "status",
              "--porcelain=v1",
              "-z",
              "--untracked-files=normal",
              "--",
              ".",
            ],
            { cwd: this.cwd, maxBuffer: 4 * maxBytes },
          ),
          exec("git", ["branch", "--show-current"], { cwd: this.cwd }),
          exec("git", ["rev-parse", "--show-prefix"], { cwd: this.cwd }),
        ]);
      const records = stdout.split("\0");
      const changes: WorkspaceSnapshot["changes"] = [];
      for (let index = 0; index < records.length; index++) {
        const record = records[index];
        if (!record) {
          continue;
        }
        const status = record.slice(0, 2).trim();
        const repoPath = record.slice(3);
        const path =
          prefix.trim() && repoPath.startsWith(prefix.trim())
            ? repoPath.slice(prefix.trim().length)
            : repoPath;
        changes.push({ path, status });
        if (status.includes("R") || status.includes("C")) {
          index++;
        }
      }
      return { cwd: this.cwd, branch: branch.trim() || "detached", changes };
    } catch {
      return {
        cwd: this.cwd,
        branch: null,
        changes: [...this.changed].map((path) => ({ path, status: "M" })),
      };
    }
  }

  dispose(): void {
    this.watcher?.close();
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }
}
