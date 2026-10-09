import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { TaskManager } from "@/subagent/task-manager.js";
import { BashTool } from "@/tools/bash.js";
import { PowerShellTool } from "@/tools/powershell.js";
import { ToolRegistry } from "@/tools/registry.js";
import {
  attachBackgroundTaskManager,
  backgroundAllForegroundTasks,
  BACKGROUND_NOTIFICATION_BYTES,
  buildShellResult,
  formatFinalResult,
  hasAnyForegroundTasks,
  readOutputFile,
  type ShellExit,
} from "@/tools/shell-background.js";

it.each([
  { exit: { code: 0 }, isError: false, message: "captured" },
  { exit: { code: 7 }, isError: true, message: "Exit code 7" },
  {
    exit: { code: null, signal: "SIGTERM" },
    isError: true,
    message: "Process terminated by SIGTERM",
  },
  { exit: { aborted: true }, isError: true, message: "command interrupted" },
  { exit: { timedOut: true }, isError: true, message: "command timed out" },
  {
    exit: { sizeKilled: true },
    isError: true,
    message: "Command killed: output file exceeded 5GB",
  },
] satisfies { exit: Partial<ShellExit>; isError: boolean; message: string }[])(
  "preserves execution status when output is truncated: $message",
  ({ exit, isError, message }) => {
    for (const prompt of ["$ ", "PS> "]) {
      const result = formatFinalResult(
        prompt,
        "emit-output",
        {
          code: 0,
          signal: null,
          aborted: false,
          timedOut: false,
          sizeKilled: false,
          ...exit,
        },
        "captured",
        true,
        30,
      );
      expect(result.isError).toBe(isError);
      expect(result.output).toContain("[Output truncated after 10 MB]");
      expect(result.output).toContain(message);
    }
  },
);

it("keeps non-zero exit hints visible after truncation", () => {
  const result = formatFinalResult(
    "$ ",
    "rg needle .",
    {
      code: 1,
      signal: null,
      aborted: false,
      timedOut: false,
      sizeKilled: false,
    },
    "captured",
    true,
    30,
  );
  expect(result.isError).toBe(true);
  expect(result.output).toContain("Exit code 1 (no matches found)");
});

it("attaches managers to the original shell instances and preserves their methods", () => {
  const registry = new ToolRegistry();
  const tools = [new BashTool(), new PowerShellTool()];
  const methods = tools.map((tool): unknown =>
    Reflect.get(tool, "backgroundForegroundTasks"),
  );
  for (const tool of tools) {
    registry.register(tool);
  }

  for (const manager of [new TaskManager(), new TaskManager()]) {
    attachBackgroundTaskManager(registry, manager);
    for (const [index, tool] of tools.entries()) {
      expect(tool.taskManager).toBe(manager);
      expect(Reflect.get(tool, "backgroundForegroundTasks")).toBe(
        methods[index],
      );
      expect(tool.backgroundEnabled()).toBe(true);
    }
    expect(hasAnyForegroundTasks(registry)).toBe(false);
    expect(backgroundAllForegroundTasks(registry)).toBe(0);
  }
});

it.each([
  ["taskManager", undefined],
  ["taskManager", {}],
  ["backgroundEnabled", undefined],
  ["backgroundEnabled", true],
  ["hasForegroundTasks", undefined],
  ["hasForegroundTasks", false],
  ["backgroundForegroundTasks", undefined],
  ["backgroundForegroundTasks", 1],
])("ignores an invalid background capability %s=%s", (property, value) => {
  const registry = new ToolRegistry();
  const tool = new BashTool();
  const hasForegroundTasks = vi.spyOn(tool, "hasForegroundTasks");
  const backgroundForegroundTasks = vi.spyOn(tool, "backgroundForegroundTasks");
  Reflect.set(tool, property, value);
  const originalManager = tool.taskManager;
  registry.register(tool);

  attachBackgroundTaskManager(registry, new TaskManager());
  expect(tool.taskManager).toBe(originalManager);
  expect(hasAnyForegroundTasks(registry)).toBe(false);
  expect(backgroundAllForegroundTasks(registry)).toBe(0);
  expect(hasForegroundTasks).not.toHaveBeenCalled();
  expect(backgroundForegroundTasks).not.toHaveBeenCalled();
});

it("ignores absent shell tools", () => {
  const registry = new ToolRegistry();
  attachBackgroundTaskManager(registry, new TaskManager());
  expect(hasAnyForegroundTasks(registry)).toBe(false);
  expect(backgroundAllForegroundTasks(registry)).toBe(0);
});

it.each([BashTool, PowerShellTool])(
  "does not advertise disabled foreground executions for %s",
  async (Tool) => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-foreground-"));
    try {
      const tool = new Tool();
      tool.taskManager = new TaskManager();
      const pending = tool.execute(
        { cwd: dir, taskManager: null },
        {
          command: "exit 0",
        },
      );
      expect(tool.hasForegroundTasks()).toBe(false);
      expect(tool.backgroundForegroundTasks()).toBe(0);
      await pending;
      expect(tool.taskManager.list()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it("truncates output on a UTF-8 boundary", () => {
  const dir = mkdtempSync(join(tmpdir(), "yukino-output-"));
  try {
    const path = join(dir, "output");
    writeFileSync(path, "a日本🙂z");
    for (const [limit, expected] of [
      [2, "a"],
      [4, "a日"],
      [6, "a日"],
      [9, "a日本"],
    ] as const) {
      expect(readOutputFile(path, limit)).toEqual({
        text: expected,
        size: 12,
        truncated: true,
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("reads live output tails without splitting a UTF-8 character", () => {
  const dir = mkdtempSync(join(tmpdir(), "yukino-output-tail-"));
  try {
    const path = join(dir, "output");
    writeFileSync(path, "a日本🙂z");
    for (const [limit, expected] of [
      [2, "z"],
      [5, "🙂z"],
      [7, "🙂z"],
      [8, "本🙂z"],
    ] as const) {
      expect(readOutputFile(path, limit, true)).toEqual({
        text: expected,
        size: 12,
        truncated: true,
      });
    }
    writeFileSync(path, "日本語 latest", { flag: "a" });
    expect(readOutputFile(path, 7, true).text).toBe(" latest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("reports file-backed multibyte previews in bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "yukino-output-"));
  try {
    const path = join(dir, "output");
    writeFileSync(path, "あ".repeat(11_000));

    const result = buildShellResult(
      "$ ",
      "emit-unicode",
      {
        code: 0,
        signal: null,
        aborted: false,
        timedOut: false,
        sizeKilled: false,
      },
      path,
      30,
      BACKGROUND_NOTIFICATION_BYTES,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Output too large (33000 bytes)");
    expect(result.output).toContain("Preview (first 1998 bytes)");
    expect(result.output).not.toContain("characters");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each([
  { text: "日本語", persisted: false },
  { text: "日本語🙂", persisted: true },
])("preserves output at the display limit: $text", ({ text, persisted }) => {
  const dir = mkdtempSync(join(tmpdir(), "yukino-inline-output-"));
  try {
    const path = join(dir, "output");
    writeFileSync(path, text);
    const result = buildShellResult(
      "$ ",
      "emit-unicode",
      {
        code: 0,
        signal: null,
        aborted: false,
        timedOut: false,
        sizeKilled: false,
      },
      path,
      30,
      9,
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain(text);
    expect(result.output.includes("<persisted-output>")).toBe(persisted);
    expect(existsSync(path)).toBe(persisted);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
