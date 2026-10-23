import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LLMClient } from "@yukino.js/llm/client.js";
import { TaskManager } from "@yukino.js/subagent/task-manager.js";
import { ToolRegistry } from "@yukino.js/tools/registry.js";
import { WorkflowsDialog } from "@yukino.js/ui/workflows-dialog.js";
import { WorkflowService } from "@yukino.js/workflow/service.js";
import { render, type Instance } from "ink";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { VirtualTerminal } from "./helpers/virtual-terminal.js";

let terminal: VirtualTerminal;
let instance: Instance | undefined;
let service: WorkflowService;
let tasks: TaskManager;
let cwd: string;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  cwd = mkdtempSync(join(tmpdir(), "yukino-workflows-panel-"));
  terminal = new VirtualTerminal(100, 24);
  tasks = new TaskManager();
  const client: LLMClient = {
    setSystemPrompt() {},
    async *stream() {
      yield await Promise.resolve({
        type: "text_delta" as const,
        text: "done",
      });
      yield {
        type: "stream_end",
        stopReason: "end_turn",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      };
    },
  };
  service = new WorkflowService({
    cwd,
    registry: new ToolRegistry(),
    taskManager: tasks,
    getClient: () => client,
    getProvider: () => ({
      name: "test",
      protocol: "anthropic",
      base_url: "http://localhost",
      model: "test",
    }),
  });
});
afterEach(async () => {
  act(() => {
    instance?.unmount();
    instance?.cleanup();
  });
  await tasks.stopAll();
  terminal.dispose();
  rmSync(cwd, { recursive: true, force: true });
  vi.unstubAllGlobals();
});
async function flush() {
  await act(async () => {
    await instance?.waitUntilRenderFlush();
    await terminal.flush();
  });
}
async function press(input: string) {
  await act(async () => {
    terminal.inputStream.write(input);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await flush();
}

it("shows history and phases, resumes a finished run, and closes without stopping work", async () => {
  const run = await service.launch(
    {
      script:
        "export const meta = {name: 'review', description: 'Review changes', phases: [{title: 'Inspect'}]}\nphase('Inspect'); return await agent('task', {label: 'reader'})",
    },
    { cwd },
  );
  await tasks.waitAll();
  const close = vi.fn();
  await act(async () => {
    instance = render(
      <WorkflowsDialog
        service={service}
        context={() => ({ cwd })}
        onClose={close}
      />,
      {
        stdin: terminal.stdin,
        stdout: terminal.stdout,
        stderr: terminal.stdout,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await flush();
  expect(terminal.bufferLines().join("\n")).toContain("reader");
  expect(terminal.bufferLines().join("\n")).toContain("Inspect");
  await press("r");
  await vi.waitFor(() => {
    expect(tasks.list()).toHaveLength(2);
  });
  await act(async () => {
    await tasks.waitAll();
  });
  await flush();
  expect(tasks.list()).toHaveLength(2);
  expect(service.store.get(run.runId)?.status).toBe("completed");
  await press("q");
  expect(close).toHaveBeenCalledOnce();
});

it("fits a narrow terminal and exposes an empty state", async () => {
  terminal.resize(38, 12);
  await act(async () => {
    instance = render(
      <WorkflowsDialog
        service={service}
        context={() => ({ cwd })}
        onClose={() => undefined}
      />,
      {
        stdin: terminal.stdin,
        stdout: terminal.stdout,
        stderr: terminal.stdout,
        patchConsole: false,
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await flush();
  expect(terminal.bufferLines().join("\n")).toContain("Workflows");
  expect(terminal.bufferLines().join("\n")).toContain("No workflow runs");
});
