import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import {
  getExecutionContext,
  withExecutionContext,
  type ExecutionContext,
} from "@/cost/context.js";
import { createCostLedger } from "@/cost/ledger.js";
import type { LLMClient } from "@/llm/client.js";
import { PermissionChecker } from "@/permissions/index.js";
import * as Subagent from "@/subagent/spawn.js";
import {
  registerSessionStorageTarget,
  TaskManager,
} from "@/subagent/task-manager.js";
import { CodeModeTool } from "@/tools/code-mode.js";
import { ToolRegistry } from "@/tools/registry.js";
import type { PermissionRequestHandler } from "@/tools/types.js";
import { WriteFileTool } from "@/tools/write-file.js";
import { createYukinoBackend, YukinoWorkflowHost } from "@/workflow/backend.js";
import { createHostHandle } from "@/workflow/ports.js";
import { WorkflowService } from "@/workflow/service.js";

const directories: string[] = [];
const managers: TaskManager[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(git: boolean, codeMode = false) {
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
  const contexts: ExecutionContext[] = [];
  const client: LLMClient = {
    setSystemPrompt() {},
    async *stream() {
      const context = getExecutionContext();
      if (context) {
        contexts.push(context);
      }
      requests();
      if (requests.mock.calls.length === 1) {
        yield await Promise.resolve({
          type: "tool_call_complete" as const,
          toolId: "write",
          toolName: codeMode ? "CodeMode" : "WriteFile",
          arguments: codeMode
            ? {
                code: "return (await tools.WriteFile({file_path:'created.txt', content:'workflow change'})).output",
              }
            : { file_path: "created.txt", content: "workflow change" },
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
  if (codeMode) {
    registry.setPolicy({ codeModeEnabled: true });
    registry.register(new CodeModeTool());
  }
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
  return { cwd, requests, contexts, registry, taskManager, service };
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

it("lets a child Workflow's actual Agent execute CodeMode with a nested native write", async () => {
  const f = fixture(false, true);
  writeFileSync(join(f.cwd, "child.js"), "return await agent('create a file')");
  const run = await f.service.launch(
    { script: "return await workflow({scriptPath:'child.js'})" },
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
  expect(existsSync(join(f.cwd, "created.txt"))).toBe(true);
  expect(f.requests).toHaveBeenCalledTimes(2);
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

it.each([false, true])(
  "attributes actual workflow worker requests to the root ledger (nested=%s)",
  async (nested) => {
    const f = fixture(false);
    const ledger = createCostLedger({
      sessionId: "root-session",
      persist: false,
    });
    registerSessionStorageTarget(ledger, null);
    const root: ExecutionContext = {
      sessionId: ledger.sessionId,
      runId: "root-run",
      agentId: "leader",
      purpose: "main",
      ledger,
    };
    if (nested) {
      writeFileSync(
        join(f.cwd, "child.js"),
        "return await agent('create a file')",
      );
    }
    const run = await withExecutionContext(root, () =>
      f.service.launch(
        {
          script: nested
            ? "return await workflow({scriptPath:'child.js'})"
            : "return await agent('create a file')",
        },
        {
          cwd: f.cwd,
          permissionChecker: new PermissionChecker(f.cwd, "bypassPermissions"),
        },
      ),
    );
    await f.taskManager.waitAll();
    expect(f.service.store.get(run.runId)?.status).toBe("completed");
    expect(f.contexts).toHaveLength(2);
    for (const context of f.contexts) {
      expect(context.ledger).toBe(ledger);
      expect(context).toMatchObject({
        sessionId: "root-session",
        purpose: "workflow",
      });
      expect(context.parentRunId).toBe(run.runId);
    }
    expect(f.contexts[0].runId).toBe(f.contexts[1].runId);
  },
);

it.each([
  { policy: { codeModeEnabled: false }, options: "" },
  { policy: { codeModeEnabled: true, denylist: ["WriteFile"] }, options: "" },
  { policy: { codeModeEnabled: true, allowlist: ["CodeMode"] }, options: "" },
  {
    policy: { codeModeEnabled: true },
    options: ", {allowedTools:['CodeMode']}",
  },
  { policy: { codeModeEnabled: true }, options: ", {agentType:'explore'}" },
])(
  "keeps CodeMode nested writes within parent and worker authority ($policy, $options)",
  async ({ policy, options }) => {
    const f = fixture(false, true);
    f.registry.setPolicy(policy);
    const run = await f.service.launch(
      { script: `return await agent('create a file'${options})` },
      {
        cwd: f.cwd,
        permissionChecker: new PermissionChecker(f.cwd, "bypassPermissions"),
      },
    );
    await f.taskManager.waitAll();
    expect(f.service.store.get(run.runId)?.status).toBe("completed");
    expect(f.requests).toHaveBeenCalledTimes(2);
    expect(existsSync(join(f.cwd, "created.txt"))).toBe(false);
  },
);

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

it("passes complete workflow attribution and explicit host persistence to the worker", async () => {
  const f = fixture(false);
  const ledger = createCostLedger({
    sessionId: "root-session",
    persist: false,
  });
  const root: ExecutionContext = {
    sessionId: ledger.sessionId,
    runId: "root-run",
    agentId: "leader",
    purpose: "main",
    ledger,
  };
  const spawn = vi
    .spyOn(Subagent, "spawnSubagent")
    .mockResolvedValue("finished");
  const backend = createYukinoBackend({
    registry: f.registry,
    getClient: () => ({ setSystemPrompt() {}, async *stream() {} }),
    getProvider: () => ({
      name: "test",
      model: "test",
      protocol: "anthropic",
      base_url: "http://localhost",
    }),
  });
  const result = await backend.run(
    { prompt: "work" },
    {
      host: createHostHandle(
        new YukinoWorkflowHost(
          { cwd: f.cwd, sessionId: "root-session" },
          root,
          false,
        ),
      ),
      signal: new AbortController().signal,
      runId: "workflow-run",
      agentId: 7,
    },
  );
  expect(result.kind).toBe("ok");
  expect(spawn).toHaveBeenCalledOnce();
  const options = spawn.mock.calls[0][10];
  expect(options).toMatchObject({
    persist: false,
    purpose: "workflow",
    executionContext: {
      sessionId: "root-session",
      runId: "workflow-run",
      parentRunId: "root-run",
      agentId: "7",
      purpose: "workflow",
    },
  });
  expect(options?.executionContext?.ledger).toBe(ledger);
  expect(f.registry.get("WriteFile")).toBeDefined();
});
