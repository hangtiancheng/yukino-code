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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { TaskManager } from "@/subagent/task-manager.js";
import { BashTool } from "@/tools/bash.js";
import { PowerShellTool } from "@/tools/powershell.js";
import { readOutputFile } from "@/tools/shell-background.js";

it.each([BashTool, PowerShellTool])(
  "does not advertise disabled foreground executions for %s",
  async (Tool) => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-foreground-"));
    try {
      const tool = new Tool();
      tool.taskManager = new TaskManager();
      const pending = tool.execute(
        { workDir: dir, taskManager: null },
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
