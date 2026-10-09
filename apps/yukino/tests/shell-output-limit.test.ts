import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { TaskManager } from "@/subagent/task-manager.js";
import { BashTool } from "@/tools/bash.js";
import { PowerShellTool } from "@/tools/powershell.js";
import type * as shellBackground from "@/tools/shell-background.js";

vi.mock("@/tools/shell-background.js", async (importOriginal) => ({
  ...(await importOriginal<typeof shellBackground>()),
  MAX_SHELL_OUTPUT_FILE_BYTES: 1024,
}));

const pwshAvailable =
  process.platform === "win32" ||
  spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
    timeout: 20_000,
  }).status === 0;

for (const { Tool, command, available } of [
  {
    Tool: BashTool,
    command:
      "trap 'exit 0' TERM; node -e 'process.stdout.write(\"x\".repeat(2048)); setInterval(() => {}, 1000)'",
    available: true,
  },
  {
    Tool: PowerShellTool,
    command:
      "[Console]::Write(('x' * 2048)); [System.Threading.Thread]::Sleep(60000)",
    available: pwshAvailable,
  },
]) {
  it.skipIf(!available).each([false, true])(
    `${Tool.name} reports disk-cap termination as an error (background=%s)`,
    async (background) => {
      const dir = mkdtempSync(join(tmpdir(), "yukino-shell-cap-"));
      const tool = new Tool();
      const manager = new TaskManager();
      tool.taskManager = manager;
      try {
        const result = await tool.execute(
          { cwd: dir, sessionId: "shell-cap" },
          { command, run_in_background: background, timeout: 10 },
        );
        if (background) {
          const task = manager.list()[0];
          expect(task).toBeDefined();
          await task?.done;
          expect(task?.status).toBe("failed");
          expect(task?.output).toContain(
            "Command killed: output file exceeded 5GB",
          );
        } else {
          expect(result.isError).toBe(true);
          expect(result.output).toContain(
            "Command killed: output file exceeded 5GB",
          );
        }
      } finally {
        await manager.stopAll();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    15_000,
  );
}
