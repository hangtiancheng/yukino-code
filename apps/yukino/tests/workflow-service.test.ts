import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultRegistry } from "@yukino.js/commands/commands.js";
import type { ProviderConfig } from "@yukino.js/config/provider-config.js";
import type { LLMClient, LLMStreamOptions } from "@yukino.js/llm/client.js";
import { PermissionChecker } from "@yukino.js/permissions";
import { newSessionId } from "@yukino.js/session";
import { projectPath } from "@yukino.js/storage";
import { formatAgentTaskNotification } from "@yukino.js/subagent/prompts.js";
import { TaskManager } from "@yukino.js/subagent/task-manager.js";
import { ToolRegistry } from "@yukino.js/tools/registry.js";
import type { ProviderToolSchema, Tool } from "@yukino.js/tools/types.js";
import { contentToText } from "@yukino.js/utils";
import { extractStructuredOutput } from "@yukino.js/workflow/backend.js";
import { WORKFLOW_RUNS_DIR } from "@yukino.js/workflow/constants.js";
import { WorkflowService } from "@yukino.js/workflow/service.js";
import { attachWorkflow } from "@yukino.js/workflow/wiring.js";
import { WorkflowTool } from "@yukino.js/workflow/workflow-tool.js";

const provider: ProviderConfig = {
  name: "test",
  model: "test",
  base_url: "http://localhost",
  protocol: "anthropic",
};
const directories: string[] = [];
const managers: TaskManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(
  answer: (prompt: string, signal?: AbortSignal) => Promise<string> = (
    prompt,
  ) => Promise.resolve(prompt),
) {
  const cwd = mkdtempSync(join(tmpdir(), "yukino-workflow-service-"));
  directories.push(cwd);
  const calls: {
    prompt: string;
    tools: ProviderToolSchema[];
    options?: LLMStreamOptions;
  }[] = [];
  const client: LLMClient = {
    setSystemPrompt() {},
    async *stream(conversation, tools, signal, options) {
      const prompt = contentToText(
        conversation.getMessages().at(-1)?.content ?? "",
      );
      calls.push({ prompt, tools, options });
      yield { type: "text_delta", text: await answer(prompt, signal) };
      yield {
        type: "stream_end",
        stopReason: "end_turn",
        usage: {
          inputTokens: 5,
          outputTokens: 2,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      };
    },
  };
  const sessionId = newSessionId();
  const taskManager = new TaskManager(sessionId);
  managers.push(taskManager);
  const registry = new ToolRegistry();
  const options = {
    cwd,
    registry,
    taskManager,
    getClient: () => client,
    getProvider: () => provider,
  };
  const service = attachWorkflow(options);
  const tool = registry.getInstanceOf("Workflow", WorkflowTool);
  if (!tool) {
    throw new Error("Workflow tool was not registered");
  }
  const context = {
    cwd,
    permissionChecker: new PermissionChecker(cwd, "bypassPermissions"),
  };
  return {
    cwd,
    calls,
    sessionId,
    taskManager,
    registry,
    options,
    service,
    tool,
    context,
  };
}

function fakeTool(name: string): Tool {
  return {
    name,
    description: name,
    category: "read",
    schema: () => ({
      name,
      description: name,
      input_schema: { type: "object", properties: {} },
    }),
    execute: () => Promise.resolve({ output: "ok", isError: false }),
  };
}

describe("Yukino workflow integration", () => {
  it("runs actual subagent loops and delivers the complete result through TaskManager", async () => {
    const f = fixture();
    const run = await f.service.launch(
      {
        script: "return await parallel(args.map(item => () => agent(item)))",
        args: ["alpha", "beta"],
      },
      f.context,
    );
    await f.taskManager.waitAll();
    expect(f.calls).toHaveLength(2);
    expect(f.service.store.get(run.runId)).toMatchObject({
      status: "completed",
      returnValue: ["alpha", "beta"],
    });
    const notifications = f.taskManager.drainNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      id: run.taskId,
      kind: "workflow",
      status: "completed",
    });
    expect(formatAgentTaskNotification(notifications[0])).toContain("alpha");
    expect(f.taskManager.drainNotifications()).toEqual([]);
    expect(
      run.scriptPath.startsWith(projectPath(f.cwd, WORKFLOW_RUNS_DIR)),
    ).toBe(true);
    const restored = new TaskManager(f.sessionId).get(run.taskId);
    expect(restored).toMatchObject({ kind: "workflow", status: "completed" });
  });

  it("resumes saved source and JSON arguments after creating a new service", async () => {
    const f = fixture();
    const script =
      "const reply = await agent(args.value); return { reply, args }";
    const first = await f.service.launch(
      { script, args: { value: "saved", nested: [1, false, null] } },
      f.context,
    );
    await f.taskManager.waitAll();
    const service = new WorkflowService(f.options);
    await service.loadPersistedRuns();
    expect(service.store.get(first.runId)?.status).toBe("completed");
    const resumed = await service.launch(
      { resumeFromRunId: first.runId },
      f.context,
    );
    await f.taskManager.waitAll();
    expect(resumed.runId).toBe(first.runId);
    expect(resumed.taskId).not.toBe(first.taskId);
    expect(f.calls).toHaveLength(1);
    expect(service.store.get(first.runId)?.returnValue).toEqual({
      reply: "saved",
      args: { value: "saved", nested: [1, false, null] },
    });
    expect(service.store.get(first.runId)?.agents).toHaveLength(1);
  });

  it("preserves JSON strings without legacy argument coercion", async () => {
    const f = fixture();
    const run = await f.service.launch(
      { script: "return args", args: '{"value":1}' },
      f.context,
    );
    await f.taskManager.waitAll();
    expect(f.service.store.get(run.runId)?.returnValue).toBe('{"value":1}');
  });

  it("supports named commands and editable persisted scripts", async () => {
    const f = fixture();
    const directory = join(f.cwd, ".yukino", "workflows");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "inspect-files.js"),
      "export const meta = {name: 'inspect-files', description: 'Review'}\nreturn await agent(args)",
    );
    writeFileSync(
      join(directory, "inspect-files.mjs"),
      "return 'lower priority'",
    );
    const commands = createDefaultRegistry();
    await f.service.registerNamedCommands(commands);
    expect(
      commands.find("inspect-files")?.handler({ cwd: f.cwd, args: "test" }),
    ).toContain('name="inspect-files"');
    expect(
      commands.find("ultracode")?.handler({ cwd: f.cwd, args: "task" }),
    ).toContain("Workflow");
    const run = await f.service.launch(
      { name: "inspect-files", args: "input" },
      f.context,
    );
    await f.taskManager.waitAll();
    writeFileSync(run.scriptPath, "return await agent('edited')");
    await f.service.launch(
      { resumeFromRunId: run.runId, scriptPath: run.scriptPath },
      f.context,
    );
    await f.taskManager.waitAll();
    expect(f.service.store.get(run.runId)?.returnValue).toBe("edited");
    expect(await readFile(run.scriptPath, "utf8")).toContain("edited");
  });

  it("rejects invalid source and schema before creating background tasks", async () => {
    const f = fixture();
    for (const args of [
      { script: "const value: number = 1" },
      {},
      { script: "return 1", name: "other" },
      { name: "../escape" },
      { resumeFromRunId: "../escape" },
    ]) {
      expect((await f.tool.execute(f.context, args)).isError).toBe(true);
    }
    expect(f.taskManager.list()).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it("honors allowedTools and maxTokens while excluding recursive Workflow calls", async () => {
    const f = fixture();
    f.registry.register(fakeTool("ReadFile"));
    f.registry.register(fakeTool("WriteFile"));
    await f.service.launch(
      {
        script:
          "return await agent('task', {allowedTools: ['ReadFile', 'Workflow'], maxTokens: 123})",
      },
      f.context,
    );
    await f.taskManager.waitAll();
    expect(
      f.calls[0].tools.map((tool) => ("name" in tool ? tool.name : "")),
    ).toEqual(["ReadFile"]);
    expect(f.calls[0].options?.maxOutputTokens).toBe(123);
  });

  it("parses and validates structured output, including a schema retry", async () => {
    let attempts = 0;
    const f = fixture(() =>
      Promise.resolve(
        ++attempts === 1
          ? '{"value":"wrong"}'
          : 'Done.\n```json\n{"value":42}\n```',
      ),
    );
    const run = await f.service.launch(
      {
        script:
          "return await agent('task', {schema: {type: 'object', properties: {value: {type: 'number'}}, required: ['value']}})",
      },
      f.context,
    );
    await f.taskManager.waitAll();
    expect(f.calls).toHaveLength(2);
    expect(f.service.store.get(run.runId)?.returnValue).toEqual({ value: 42 });
  });

  it("does not cancel detached workflows when the launching turn ends", async () => {
    let release: ((value: string) => void) | undefined;
    const f = fixture(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const parent = new AbortController();
    const run = await f.service.launch(
      { script: "return await agent('task')" },
      { ...f.context, abortSignal: parent.signal },
    );
    await vi.waitFor(() => {
      expect(release).toBeTypeOf("function");
    });
    parent.abort();
    release?.("finished");
    await f.taskManager.waitAll();
    expect(f.service.store.get(run.runId)?.status).toBe("completed");
  });

  it("cancels through the native task registry and persists killed after cleanup", async () => {
    const f = fixture(
      (_prompt, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    );
    const run = await f.service.launch(
      {
        script:
          "return await parallel(['a','b','c','d'].map(item => () => agent(item)))",
        maxConcurrency: 1,
      },
      f.context,
    );
    await vi.waitFor(() => {
      expect(f.calls).toHaveLength(1);
    });
    await f.taskManager.stopAndWait(run.taskId);
    expect(f.service.store.get(run.runId)?.status).toBe("killed");
    expect(f.calls).toHaveLength(1);
    expect(f.taskManager.get(run.taskId)?.status).toBe("cancelled");
    expect((await f.service.persistence.list())[0].status).toBe("killed");
  });

  it("records cancellation even before the engine starts", async () => {
    const f = fixture();
    const run = await f.service.launch(
      { script: "return await agent('never')" },
      f.context,
    );
    await f.taskManager.stopAndWait(run.taskId);
    expect(f.calls).toHaveLength(0);
    expect(f.service.store.get(run.runId)?.status).toBe("killed");
    expect((await f.service.persistence.list())[0].status).toBe("killed");
  });

  it("rejects duplicate active resumes and reports execution errors as failed tasks", async () => {
    const f = fixture();
    const run = await f.service.launch(
      { script: "throw new Error('broken workflow')" },
      f.context,
    );
    await expect(
      f.service.launch({ resumeFromRunId: run.runId }, f.context),
    ).rejects.toThrow("already running");
    await f.taskManager.waitAll();
    expect(f.taskManager.get(run.taskId)).toMatchObject({ status: "failed" });
    expect(await f.service.command(run.runId, f.context)).toContain(
      "broken workflow",
    );
  });

  it.each([
    '{"a":{"text":"}"}}',
    '[1,{"x":2}]',
    "true",
    "42",
    '"text"',
    "null",
  ])("extracts JSON output %s", (text) => {
    expect(extractStructuredOutput(text)).toEqual(JSON.parse(text));
  });
});
