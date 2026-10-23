import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { LLMClient } from "@yukino.js/llm/client.js";
import { PermissionChecker } from "@yukino.js/permissions";
import { TaskManager } from "@yukino.js/subagent/task-manager.js";
import { ToolRegistry } from "@yukino.js/tools/registry.js";
import type { PermissionRequestHandler } from "@yukino.js/tools/types.js";
import { WriteFileTool } from "@yukino.js/tools/write-file.js";
import { WorkflowService } from "@yukino.js/workflow/service.js";

const directories: string[] = [];
const managers: TaskManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(git: boolean) {
  const cwd = mkdtempSync(join(tmpdir(), "yukino-workflow-backend-"));
  directories.push(cwd);
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd });
    writeFileSync(join(cwd, "initial.txt"), "initial");
    execFileSync("git", ["add", "."], { cwd });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "initial",
      ],
      { cwd },
    );
  }
  const requests = vi.fn();
  const client: LLMClient = {
    setSystemPrompt() {},
    async *stream() {
      requests();
      if (requests.mock.calls.length === 1) {
        yield await Promise.resolve({
          type: "tool_call_complete" as const,
          toolId: "write",
          toolName: "WriteFile",
          arguments: { file_path: "created.txt", content: "workflow change" },
        });
        yield {
          type: "stream_end",
          stopReason: "tool_use",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        };
      } else {
        yield { type: "text_delta", text: "finished" };
        yield {
          type: "stream_end",
          stopReason: "end_turn",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        };
      }
    },
  };
  const registry = new ToolRegistry();
  registry.register(new WriteFileTool());
  const taskManager = new TaskManager();
  managers.push(taskManager);
  const service = new WorkflowService({
    cwd,
    registry,
    taskManager,
    getClient: () => client,
    getProvider: () => ({
      name: "test",
      model: "test",
      base_url: "http://localhost",
      protocol: "anthropic",
    }),
  });
  return { cwd, requests, taskManager, service };
}

it("executes tool writes inside the isolated Git worktree and retains changes", async () => {
  const f = fixture(true);
  const run = await f.service.launch(
    { script: "return await agent('create a file', {isolation: 'worktree'})" },
    {
      cwd: f.cwd,
      permissionChecker: new PermissionChecker(f.cwd, "bypassPermissions"),
    },
  );
  await f.taskManager.waitAll();
  expect(f.service.store.get(run.runId)).toMatchObject({
    status: "completed",
    returnValue: "finished",
  });
  expect(f.requests).toHaveBeenCalledTimes(2);
  expect(existsSync(join(f.cwd, "created.txt"))).toBe(false);
  const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: f.cwd,
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice(9));
  expect(worktrees).toHaveLength(2);
  expect(worktrees.some((path) => existsSync(join(path, "created.txt")))).toBe(
    true,
  );
});

it("does not run a worker in the parent directory when isolation fails", async () => {
  const f = fixture(false);
  const run = await f.service.launch(
    { script: "return await agent('create a file', {isolation: 'worktree'})" },
    { cwd: f.cwd },
  );
  await f.taskManager.waitAll();
  expect(f.service.store.get(run.runId)?.returnValue).toBeNull();
  expect(f.requests).not.toHaveBeenCalled();
  expect(existsSync(join(f.cwd, "created.txt"))).toBe(false);
});

it("routes worker writes through the inherited permission prompt", async () => {
  const f = fixture(false);
  const request = vi.fn<PermissionRequestHandler>(() =>
    Promise.resolve("deny"),
  );
  await f.service.launch(
    { script: "return await agent('create a file')" },
    {
      cwd: f.cwd,
      permissionChecker: new PermissionChecker(f.cwd, "default"),
      onPermissionRequest: request,
    },
  );
  await f.taskManager.waitAll();
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls[0][0]).toBe("WriteFile");
  expect(existsSync(join(f.cwd, "created.txt"))).toBe(false);
});
