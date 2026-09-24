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

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Sandbox, SandboxConfig } from "@/sandbox/index.js";
import {
  formatAgentTaskNotification,
  TaskManager,
} from "@/subagent/task-manager.js";
import { BashTool } from "@/tools/bash.js";
import type { ToolContext } from "@/tools/types.js";

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workDir: mkdtempSync(join(tmpdir(), "yukino-bash-bg-")),
    ...overrides,
  };
}

function makeTool(): { bash: BashTool; tasks: TaskManager } {
  const bash = new BashTool();
  const tasks = new TaskManager();
  bash.taskManager = tasks;
  return { bash, tasks };
}

function taskIdFrom(output: string): string {
  const match = /task_id: (bash-\d+)\)/.exec(output);
  expect(match, `expected a task_id in: ${output}`).not.toBeNull();
  return match?.[1] ?? "";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  delete process.env.YUKINO_DISABLE_BACKGROUND_TASKS;
});

describe("bash background execution", () => {
  it("omits run_in_background from the schema without a task manager", () => {
    const bare = new BashTool();
    expect(bare.backgroundEnabled()).toBe(false);
    expect(JSON.stringify(bare.schema())).not.toContain("run_in_background");

    const { bash } = makeTool();
    expect(bash.backgroundEnabled()).toBe(true);
    const schema = JSON.stringify(bash.schema());
    expect(schema).toContain("run_in_background");
    expect(schema).toContain("task notification");
  });

  it("honors YUKINO_DISABLE_BACKGROUND_TASKS", () => {
    const { bash } = makeTool();
    process.env.YUKINO_DISABLE_BACKGROUND_TASKS = "1";
    expect(bash.backgroundEnabled()).toBe(false);
    expect(JSON.stringify(bash.schema())).not.toContain("run_in_background");
  });

  it("runs run_in_background commands as tasks and notifies with the output", async () => {
    const { bash, tasks } = makeTool();
    const result = await bash.execute(makeContext(), {
      command: "printf hello-bg",
      run_in_background: true,
    });
    expect(result.isError).toBe(false);
    const taskId = taskIdFrom(result.output);
    expect(result.output).toContain("do not poll");

    const task = tasks.get(taskId);
    expect(task).toBeDefined();
    await task?.done;
    expect(task?.status).toBe("completed");

    const notified = tasks.drainNotifications();
    expect(notified.map((t) => t.id)).toEqual([taskId]);
    const xml = notified.map(formatAgentTaskNotification).join("\n");
    expect(xml).toContain(
      `<task-notification task_id="${taskId}" status="completed">`,
    );
    expect(xml).toContain("hello-bg");
  });

  it("marks non-zero background exits as failed while preserving the output", async () => {
    const { bash, tasks } = makeTool();
    const result = await bash.execute(makeContext(), {
      command: "printf oops >&2; exit 3",
      run_in_background: true,
    });
    const taskId = taskIdFrom(result.output);
    const task = tasks.get(taskId);
    await task?.done;
    expect(task?.status).toBe("failed");
    expect(task?.output).toContain("oops");
    expect(task?.output).toContain("Exit code 3");
    expect(task?.output).not.toContain("Error: task failed");
  });

  it("moves a timed-out foreground command to the background instead of killing it", async () => {
    const { bash, tasks } = makeTool();
    const started = Date.now();
    const result = await bash.execute(makeContext(), {
      command: "node -e \"setTimeout(() => console.log('late-done'), 1200)\"",
      timeout: 1,
    });
    // The tool call returns at the 1s timeout, not at process exit.
    expect(Date.now() - started).toBeLessThan(2500);
    expect(result.isError).toBe(false);
    expect(result.output).toContain("moved to the background");
    const taskId = taskIdFrom(result.output);

    const task = tasks.get(taskId);
    await task?.done;
    expect(task?.status).toBe("completed");
    expect(task?.output).toContain("late-done");
  }, 15_000);

  it("still kills a bare sleep on timeout (auto-background blocklist)", async () => {
    const { bash, tasks } = makeTool();
    const result = await bash.execute(makeContext(), {
      command: "sleep 5",
      timeout: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("command timed out after 1s");
    expect(tasks.list()).toHaveLength(0);
  }, 10_000);

  it("backgrounds running foreground commands on demand (Ctrl+B path)", async () => {
    const { bash, tasks } = makeTool();
    const pending = bash.execute(makeContext(), {
      command: "node -e \"setTimeout(() => console.log('bg-manual'), 1200)\"",
      timeout: 30,
    });
    await sleep(300);
    expect(bash.hasForegroundTasks()).toBe(true);
    expect(bash.backgroundForegroundTasks()).toBe(1);
    expect(bash.hasForegroundTasks()).toBe(false);

    const result = await pending;
    expect(result.isError).toBe(false);
    expect(result.output).toContain("manually backgrounded by the user");
    const taskId = taskIdFrom(result.output);

    const task = tasks.get(taskId);
    await task?.done;
    expect(task?.status).toBe("completed");
    expect(task?.output).toContain("bg-manual");
    expect(bash.backgroundForegroundTasks()).toBe(0);
  }, 15_000);

  it("kills the process tree when a background bash task is stopped", async () => {
    const { bash, tasks } = makeTool();
    const result = await bash.execute(makeContext(), {
      command: "sleep 30",
      run_in_background: true,
    });
    const taskId = taskIdFrom(result.output);
    const task = tasks.get(taskId);
    expect(task?.status).toBe("running");

    expect(tasks.stop(taskId)).toBe(true);
    const stopped = Date.now();
    await task?.done;
    // SIGKILL lands immediately; no SIGTERM grace period.
    expect(Date.now() - stopped).toBeLessThan(2000);
    expect(task?.status).toBe("cancelled");
  }, 10_000);

  it("keeps oversized background output on disk and references the live file", async () => {
    const { bash, tasks } = makeTool();
    const ctx = makeContext({ sessionId: "bg-session" });
    const result = await bash.execute(ctx, {
      command: "node -e \"process.stdout.write('x'.repeat(40000))\"",
      run_in_background: true,
    });
    const taskId = taskIdFrom(result.output);
    const task = tasks.get(taskId);
    await task?.done;
    expect(task?.status).toBe("completed");
    expect(task?.output).toContain("<persisted-output>");

    // fd mode: the notification references the live output file (no copy).
    const match = /Full content saved to:\n(\S+)/.exec(task?.output ?? "");
    expect(match).not.toBeNull();
    const outputPath = match?.[1] ?? "";
    const expectedDir = join(
      ctx.workDir,
      ".yukino",
      "sessions",
      "bg-session",
      "tool-results",
    );
    expect(outputPath.startsWith(expectedDir)).toBe(true);
    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, "utf-8")).toContain("x".repeat(100));
  }, 15_000);

  it("keeps foreground behavior unchanged without a task manager", async () => {
    const bash = new BashTool();
    const result = await bash.execute(makeContext(), {
      command: "printf plain-fg",
      // Ignored even when passed: the host cannot deliver notifications.
      run_in_background: true,
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("plain-fg");
    expect(result.output).not.toContain("background");
  }, 10_000);

  it("preserves the captured output when a background task is stopped", async () => {
    const { bash, tasks } = makeTool();
    const result = await bash.execute(makeContext(), {
      command: "printf partial-out; sleep 30",
      run_in_background: true,
    });
    const taskId = taskIdFrom(result.output);
    const task = tasks.get(taskId);
    // Let the partial output reach the file, then stop the task.
    await sleep(500);
    expect(tasks.stop(taskId)).toBe(true);
    await task?.done;
    expect(task?.status).toBe("cancelled");
    // The killed command's formatted output survives the stop (TaskFailure
    // preservation) instead of being replaced by "Stopped by user".
    expect(task?.output).toContain("partial-out");
    expect(task?.output).toContain("Process terminated");
  }, 10_000);

  it("treats ctx.taskManager null as background-disabled despite an instance manager", async () => {
    const { bash, tasks } = makeTool();
    const result = await bash.execute(makeContext({ taskManager: null }), {
      command: "printf teammate-fg",
      run_in_background: true,
    });
    // In-process teammate turns inject null: the command must run (and report)
    // in the foreground, never falling back to the host-wired instance manager.
    expect(result.isError).toBe(false);
    expect(result.output).toContain("teammate-fg");
    expect(result.output).not.toContain("task_id");
    expect(tasks.list()).toHaveLength(0);
  }, 10_000);

  it("grants the sandbox write access to the output file and annotates background output", async () => {
    const { bash, tasks } = makeTool();
    // Object holder: a bare `let captured` would be narrowed to `null` by TS
    // because the assignment happens inside the prepare() closure.
    const seen: { config: SandboxConfig | null } = { config: null };
    const sandbox: Sandbox = {
      implementation: "seatbelt",
      available: () => true,
      prepare: (command, config) => {
        seen.config = config;
        return {
          executable: "bash",
          args: ["-c", command],
          annotateStderr: (text) => `${text}\n[sandbox-violation]`,
        };
      },
    };
    bash.sandbox = sandbox;

    const result = await bash.execute(makeContext({ sessionId: "sbx" }), {
      command: "printf sbx-out",
      run_in_background: true,
    });
    const taskId = taskIdFrom(result.output);

    // The actual output-file path (not just the session dir) is writable under
    // a deny-default profile, and the file exists before prepare (bwrap --bind).
    expect(seen.config).not.toBeNull();
    const granted = seen.config?.allowWrite ?? [];
    const outputPath = granted.find((p) =>
      /shell-[0-9a-f]{16}\.output$/.test(p),
    );
    expect(outputPath).toBeDefined();
    expect(existsSync(outputPath ?? "")).toBe(true);

    const task = tasks.get(taskId);
    await task?.done;
    expect(task?.status).toBe("completed");
    // The sandbox's stderr annotation reaches the background notification too
    // (the foreground path applies it in settleExit).
    expect(task?.output).toContain("sbx-out");
    expect(task?.output).toContain("[sandbox-violation]");
  }, 10_000);

  it("cleans up the output file when the sandboxed spawn fails", async () => {
    const { bash } = makeTool();
    const sandbox: Sandbox = {
      implementation: "seatbelt",
      available: () => true,
      prepare: () => ({ executable: "/nonexistent/yukino-shell", args: [] }),
    };
    bash.sandbox = sandbox;

    const ctx = makeContext({ sessionId: "spawn-err" });
    const result = await bash.execute(ctx, { command: "printf never" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Error executing command");

    const dir = join(
      ctx.workDir,
      ".yukino",
      "sessions",
      "spawn-err",
      "tool-results",
    );
    const leftovers = existsSync(dir)
      ? readdirSync(dir).filter((f) => f.endsWith(".output"))
      : [];
    expect(leftovers).toHaveLength(0);
  }, 10_000);

  // Root bypasses directory permissions, so the unwritable-dir setup cannot
  // be arranged there.
  const itNonRoot =
    typeof process.getuid === "function" && process.getuid() === 0
      ? it.skip
      : it;
  itNonRoot(
    "falls back to the OS temp dir when the session dir is unwritable",
    async () => {
      const { bash } = makeTool();
      const ctx = makeContext();
      chmodSync(ctx.workDir, 0o500);
      try {
        const result = await bash.execute(ctx, {
          command: "printf fallback-ok",
        });
        expect(result.isError).toBe(false);
        expect(result.output).toContain("fallback-ok");
      } finally {
        chmodSync(ctx.workDir, 0o700);
      }
    },
    10_000,
  );
});
