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

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  formatAgentTaskNotification,
  TaskManager,
} from "@/subagent/task-manager.js";
import { PowerShellTool } from "@/tools/powershell.js";
import type { ToolContext } from "@/tools/types.js";

function pwshAvailable(): boolean {
  if (process.platform === "win32") {
    // powershell.exe ships with Windows.
    return true;
  }
  try {
    const probe = spawnSync(
      "pwsh",
      ["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
      {
        timeout: 20_000,
      },
    );
    return probe.status === 0;
  } catch {
    return false;
  }
}

const describePwsh = pwshAvailable() ? describe : describe.skip;

function makeContext(): ToolContext {
  return { workDir: mkdtempSync(join(tmpdir(), "yukino-ps-bg-")) };
}

function makeTool(): { ps: PowerShellTool; tasks: TaskManager } {
  const ps = new PowerShellTool();
  const tasks = new TaskManager();
  ps.taskManager = tasks;
  return { ps, tasks };
}

function taskIdFrom(output: string): string {
  const match = /task_id: (ps-\d+)\)/.exec(output);
  expect(match, `expected a task_id in: ${output}`).not.toBeNull();
  return match?.[1] ?? "";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describePwsh("PowerShell background execution", () => {
  it("gates run_in_background on the task manager", () => {
    const bare = new PowerShellTool();
    expect(bare.backgroundEnabled()).toBe(false);
    expect(JSON.stringify(bare.schema())).not.toContain("run_in_background");

    const { ps } = makeTool();
    expect(ps.backgroundEnabled()).toBe(true);
    expect(JSON.stringify(ps.schema())).toContain("run_in_background");
  });

  it("runs a plain foreground command in fd mode", async () => {
    const ps = new PowerShellTool();
    const result = await ps.execute(makeContext(), {
      command: "Write-Output ps-fg",
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("PS> ");
    expect(result.output).toContain("ps-fg");
  }, 30_000);

  it("runs run_in_background commands as tasks and notifies with the output", async () => {
    const { ps, tasks } = makeTool();
    const result = await ps.execute(makeContext(), {
      command: "Write-Output ps-bg",
      run_in_background: true,
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("do not poll");
    const taskId = taskIdFrom(result.output);

    const task = tasks.get(taskId);
    await task?.done;
    expect(task?.status).toBe("completed");

    const xml = tasks
      .drainNotifications()
      .map(formatAgentTaskNotification)
      .join("\n");
    expect(xml).toContain(`task_id="${taskId}" status="completed"`);
    expect(xml).toContain("ps-bg");
  }, 30_000);

  it("marks non-zero background exits as failed while preserving the output", async () => {
    const { ps, tasks } = makeTool();
    const result = await ps.execute(makeContext(), {
      command: "exit 3",
      run_in_background: true,
    });
    const taskId = taskIdFrom(result.output);
    const task = tasks.get(taskId);
    await task?.done;
    expect(task?.status).toBe("failed");
    expect(task?.output).toContain("Exit code 3");
    expect(task?.output).not.toContain("Error: task failed");
  }, 30_000);

  it("moves a timed-out command to the background instead of killing it", async () => {
    const { ps, tasks } = makeTool();
    // Not Start-Sleep: that first token is on the auto-background blocklist.
    const result = await ps.execute(makeContext(), {
      command: "[System.Threading.Thread]::Sleep(1500); Write-Output late-ps",
      timeout: 1,
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("moved to the background");
    const taskId = taskIdFrom(result.output);

    const task = tasks.get(taskId);
    await task?.done;
    expect(task?.status).toBe("completed");
    expect(task?.output).toContain("late-ps");
  }, 30_000);

  it("still kills a bare Start-Sleep on timeout (auto-background blocklist)", async () => {
    const { ps, tasks } = makeTool();
    const result = await ps.execute(makeContext(), {
      command: "Start-Sleep 5",
      timeout: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("command timed out after 1s");
    expect(tasks.list()).toHaveLength(0);
  }, 30_000);

  it("backgrounds running foreground commands on demand (Ctrl+B path)", async () => {
    const { ps, tasks } = makeTool();
    const pending = ps.execute(makeContext(), {
      command: "Start-Sleep -Milliseconds 1500; Write-Output ps-manual",
      timeout: 30,
    });
    await sleep(700);
    expect(ps.hasForegroundTasks()).toBe(true);
    expect(ps.backgroundForegroundTasks()).toBe(1);
    expect(ps.hasForegroundTasks()).toBe(false);

    const result = await pending;
    expect(result.isError).toBe(false);
    expect(result.output).toContain("manually backgrounded by the user");
    const taskId = taskIdFrom(result.output);

    const task = tasks.get(taskId);
    await task?.done;
    expect(task?.status).toBe("completed");
    expect(task?.output).toContain("ps-manual");
  }, 30_000);

  it("kills the process tree when a background task is stopped", async () => {
    const { ps, tasks } = makeTool();
    const result = await ps.execute(makeContext(), {
      command: "Start-Sleep 30",
      run_in_background: true,
    });
    const taskId = taskIdFrom(result.output);
    const task = tasks.get(taskId);
    expect(task?.status).toBe("running");

    expect(tasks.stop(taskId)).toBe(true);
    const stopped = Date.now();
    await task?.done;
    expect(Date.now() - stopped).toBeLessThan(3000);
    expect(task?.status).toBe("cancelled");
  }, 30_000);
});
