import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PermissionChecker } from "@/permissions/index.js";
import { TaskManager } from "@/subagent/task-manager.js";
import { ApplyPatchTool } from "@/tools/apply-patch.js";
import { BashTool } from "@/tools/bash.js";
import {
  acquireCommandExecution,
  acquireWorkspaceMutation,
} from "@/tools/execution-coordinator.js";
import {
  withFileMutationQueue,
  withFileMutationQueues,
} from "@/tools/file-mutation-queue.js";
import { WriteFileTool } from "@/tools/write-file.js";

let cwd: string;
let tasks: TaskManager;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "yukino-execution-"));
  tasks = new TaskManager();
});

afterEach(async () => {
  await tasks.stopAll();
  rmSync(cwd, { recursive: true, force: true });
});

describe("multi-path mutation coordination", () => {
  it("reserves overlapping paths together in FIFO order without blocking unrelated paths", async () => {
    const a = join(cwd, "a.txt");
    const b = join(cwd, "b.txt");
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocker = withFileMutationQueue(a, async () => {
      entered();
      await wait;
    });
    await started;
    const order: string[] = [];
    const first = withFileMutationQueues([a, b], () => {
      order.push("first");
      return Promise.resolve();
    });
    const second = withFileMutationQueues([b, a, b], () => {
      order.push("second");
      return Promise.resolve();
    });
    const single = withFileMutationQueue(b, () => {
      order.push("single");
      return Promise.resolve();
    });
    await withFileMutationQueue(join(cwd, "independent.txt"), () => {
      order.push("independent");
      return Promise.resolve();
    });
    expect(order).toEqual(["independent"]);
    release();
    await Promise.all([blocker, first, second, single]);
    expect(order).toEqual(["independent", "first", "second", "single"]);
  });

  it("rechecks patch permissions after waiting for all file queues", async () => {
    const file = join(cwd, "blocked.txt");
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocker = withFileMutationQueue(file, async () => {
      entered();
      await wait;
    });
    await started;
    const checker = new PermissionChecker(cwd, "bypassPermissions");
    const checks = vi.spyOn(checker, "check");
    const pending = new ApplyPatchTool().execute(
      { cwd, permissionChecker: checker, approvedPermissionMode: checker.mode },
      {
        patch:
          "--- /dev/null\n+++ first.txt\n@@ -0,0 +1,1 @@\n+first\n--- /dev/null\n+++ blocked.txt\n@@ -0,0 +1,1 @@\n+blocked\n",
      },
    );
    await vi.waitFor(() => {
      expect(checks).toHaveBeenCalled();
    });
    checker.mode = "plan";
    release();
    await blocker;
    expect((await pending).isError).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(cwd, "first.txt"))).toBe(false);
  });

  it("does not write an alias that changes while its canonical target is queued", async () => {
    const first = join(cwd, "first");
    const second = join(cwd, "second");
    const alias = join(cwd, "alias");
    mkdirSync(first);
    mkdirSync(second);
    symlinkSync(first, alias, "dir");
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocker = withFileMutationQueue(join(first, "new.txt"), async () => {
      entered();
      await wait;
    });
    await started;
    const checker = new PermissionChecker(cwd, "bypassPermissions");
    const checks = vi.spyOn(checker, "check");
    const pending = new ApplyPatchTool().execute(
      { cwd, permissionChecker: checker, approvedPermissionMode: checker.mode },
      {
        patch: "--- /dev/null\n+++ alias/new.txt\n@@ -0,0 +1,1 @@\n+new\n",
      },
    );
    await vi.waitFor(() => {
      expect(checks).toHaveBeenCalled();
    });
    await withFileMutationQueue(join(cwd, "barrier.txt"), () =>
      Promise.resolve(),
    );
    rmSync(alias);
    symlinkSync(second, alias, "dir");
    release();
    await blocker;
    expect((await pending).output).toContain(
      "Patch target changed while waiting",
    );
    expect(existsSync(join(first, "new.txt"))).toBe(false);
    expect(existsSync(join(second, "new.txt"))).toBe(false);
  });
});

describe("workspace execution coordination", () => {
  it("serializes mutating commands across tool instances while safe commands run", async () => {
    const first = new BashTool();
    first.taskManager = tasks;
    // Foreground: holds the workspace lock until the process exits, so the
    // second mutating command must queue behind it.
    const firstDone = first.execute(
      { cwd },
      {
        command:
          "printf ready > started; while [ ! -f release ]; do sleep 0.01; done; printf first >> order",
      },
    );
    await vi.waitFor(() => {
      expect(existsSync(join(cwd, "started"))).toBe(true);
    });
    let finished = false;
    const second = new BashTool()
      .execute({ cwd }, { command: "printf second >> order" })
      .then((result) => {
        finished = true;
        return result;
      });
    const safe = await new BashTool().execute(
      { cwd },
      { command: "cat started" },
    );
    expect(safe.output).toContain("ready");
    expect(finished).toBe(false);
    expect(existsSync(join(cwd, "order"))).toBe(false);
    writeFileSync(join(cwd, "release"), "");
    expect((await second).isError).toBe(false);
    expect((await firstDone).isError).toBe(false);
    expect(readFileSync(join(cwd, "order"), "utf-8")).toBe("firstsecond");
  });

  it("releases the workspace lock when a command moves to the background", async () => {
    // Regression: a backgrounded long-running command (e.g. a dev server) must
    // not keep the workspace mutation lock for its whole lifetime, or every
    // later mutating command in the same cwd queues behind it forever.
    const bash = new BashTool();
    bash.taskManager = tasks;
    const background = await bash.execute(
      { cwd },
      {
        command: 'node -e "setTimeout(() => {}, 30000)"',
        run_in_background: true,
      },
    );
    expect(background.isError).toBe(false);

    const result = await bash.execute(
      { cwd },
      { command: "printf unlocked > result" },
    );
    expect(result.isError).toBe(false);
    expect(readFileSync(join(cwd, "result"), "utf-8")).toBe("unlocked");
  }, 5_000);

  it("lets commands in independent working directories run concurrently", async () => {
    const isolated = join(cwd, "worktree");
    mkdirSync(isolated);
    const release = await acquireCommandExecution(cwd, "pnpm install");
    try {
      const result = await new BashTool().execute(
        { cwd: isolated },
        { command: "printf independent > result" },
      );
      expect(result.isError).toBe(false);
      expect(readFileSync(join(isolated, "result"), "utf-8")).toBe(
        "independent",
      );
    } finally {
      release();
    }
  });

  it("uses one queue for symlink aliases and removes cancelled waiters without disturbing FIFO", async () => {
    const alias = `${cwd}-alias`;
    symlinkSync(cwd, alias, "dir");
    const release = await acquireWorkspaceMutation(cwd);
    const abort = new AbortController();
    const cancelled = acquireWorkspaceMutation(alias, abort.signal);
    const rejection = expect(cancelled).rejects.toThrow("aborted");
    let entered = false;
    const next = acquireWorkspaceMutation(alias).then((unlock) => {
      entered = true;
      return unlock;
    });
    try {
      abort.abort();
      await rejection;
      expect(entered).toBe(false);
      release();
      (await next)();
    } finally {
      release();
      rmSync(alias);
    }
  });

  it.each(["plan", "default"] as const)(
    "rechecks permission after queued execution changes to %s",
    async (mode) => {
      const checker = new PermissionChecker(cwd, "bypassPermissions");
      const release = await acquireWorkspaceMutation(cwd);
      const pending = new BashTool().execute(
        {
          cwd,
          permissionChecker: checker,
          approvedPermissionMode: checker.mode,
        },
        { command: "printf forbidden > forbidden" },
      );
      checker.mode = mode;
      release();
      expect((await pending).isError).toBe(true);
      expect(existsSync(join(cwd, "forbidden"))).toBe(false);
      const unlock = await acquireWorkspaceMutation(cwd);
      unlock();
    },
  );

  it("coordinates file tools with commands mutating the same workspace", async () => {
    const release = await acquireCommandExecution(cwd, "pnpm install");
    const pending = new WriteFileTool().execute(
      { cwd },
      { file_path: "new.txt", content: "written" },
    );
    await Promise.resolve();
    expect(existsSync(join(cwd, "new.txt"))).toBe(false);
    release();
    expect((await pending).isError).toBe(false);
    expect(readFileSync(join(cwd, "new.txt"), "utf-8")).toBe("written");
  });

  it("does not retain a workspace slot after process startup fails", async () => {
    const result = await new BashTool().execute(
      { cwd: join(cwd, "missing") },
      { command: "touch result" },
    );
    expect(result.isError).toBe(true);
    const release = await acquireWorkspaceMutation(join(cwd, "missing"));
    release();
  });
});
