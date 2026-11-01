import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { render, type Instance } from "ink";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { VirtualTerminal } from "./helpers/virtual-terminal.js";

import type { LLMClient } from "@/llm/client.js";
import { TaskManager } from "@/subagent/task-manager.js";
import { ToolRegistry } from "@/tools/registry.js";
import { visibleWidth } from "@/ui/terminal-text.js";
import { WorkflowsDialog } from "@/ui/workflows-dialog.js";
import type { WorkflowRun } from "@/workflow/progress.js";
import { WorkflowService } from "@/workflow/service.js";

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

it.each([
  [38, 12],
  [80, 16],
  [120, 24],
])(
  "keeps the selected run and agent visible within %i columns and %i rows",
  async (columns, rows) => {
    terminal.resize(columns, rows);
    vi.spyOn(service, "loadPersistedRuns").mockResolvedValue(undefined);
    for (let index = 0; index < 8; index++) {
      const run: WorkflowRun = {
        runId: `run-${index}`,
        taskId: `task-${index}`,
        workflowName: `Review-${index}`,
        scriptPath: "",
        status: "running",
        startedAt: index,
        updatedAt: index,
        phases: [{ title: "Inspect", status: "running" }],
        agents: Array.from({ length: 20 }, (_, agent) => ({
          id: agent,
          label: `Reader-${agent}`,
          status: "running",
          tokenCount: 1200,
          toolCount: 3,
        })),
        logs: ["Reading changes"],
      };
      service.store.set(run);
    }
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
          exitOnCtrlC: false,
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    await flush();
    for (let index = 0; index < 19; index++) {
      await press("\u001b[B");
    }
    let screen = terminal.bufferLines().join("\n");
    expect(screen).toContain("Reader-19");
    expect(screen).toContain("Reading changes");
    for (let index = 0; index < 7; index++) {
      await press("\t");
    }
    screen = terminal.bufferLines().join("\n");
    expect(screen).toContain("Review-0");
    expect(screen).toContain("Reader-0");
    expect(screen).toMatch(/Esc(?:ape)?/);
    expect(terminal.terminal.buffer.active.baseY).toBe(0);
    expect(
      terminal.bufferLines().every((line) => visibleWidth(line) <= columns),
    ).toBe(true);
  },
);
