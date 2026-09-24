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
import * as os from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

import type { AgentEvent } from "@/agent/events.js";
import { Agent } from "@/agent/index.js";
import * as config from "@/config/index.js";
import type { AppConfig } from "@/config/index.js";
import * as clients from "@/llm/client.js";
import type { StreamEvent } from "@/llm/events.js";
import { OpenAIClient } from "@/llm/openai.js";
import { MCPManager } from "@/mcp/manager.js";
import { runPrintMode } from "@/print-mode.js";
import { AgentTool } from "@/subagent/agent-tool.js";
import * as subagents from "@/subagent/spawn.js";
import * as backend from "@/teams/backend.js";
import type { ToolContext } from "@/tools/types.js";
import * as worktrees from "@/worktree/index.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof os>()),
  homedir: vi.fn(),
}));

const end: Extract<StreamEvent, { type: "stream_end" }> = {
  type: "stream_end",
  stopReason: "end_turn",
  usage: {
    inputTokens: 1,
    outputTokens: 2,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  },
};

let workDir: string;
let cfg: AppConfig;
let turns: StreamEvent[][];
let requests: string[];
let previousExitCode: typeof process.exitCode;
let disconnect: MockInstance<MCPManager["disconnectAll"]>;
let connect: MockInstance<MCPManager["connectAll"]>;
let stdoutWrite: MockInstance<typeof process.stdout.write>;

beforeEach(() => {
  workDir = mkdtempSync(join(os.tmpdir(), "yukino-print-"));
  vi.spyOn(process, "cwd").mockReturnValue(workDir);
  vi.mocked(os.homedir).mockReturnValue(workDir);
  stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(console, "log").mockImplementation(() => {
    /** noop */
  });
  vi.spyOn(console, "error").mockImplementation(() => {
    /** noop */
  });
  previousExitCode = process.exitCode;
  process.exitCode = 0;
  cfg = {
    providers: [
      {
        name: "test",
        protocol: "openai",
        model: "test",
        base_url: "https://test.invalid",
      },
    ],
    hooks: [],
    mcp_servers: [{ name: "test", command: "unused" }],
  };
  vi.spyOn(config, "loadConfig").mockImplementation(() => cfg);
  connect = vi.spyOn(MCPManager.prototype, "connectAll").mockResolvedValue({
    tools: [],
    servers: [],
    errors: [],
    instructions: [],
  });
  disconnect = vi
    .spyOn(MCPManager.prototype, "disconnectAll")
    .mockResolvedValue();
  turns = [[{ type: "text_delta", text: "answer" }, end]];
  requests = [];
  const client = new OpenAIClient(
    { ...cfg.providers[0], api_key: "test" },
    "system",
  );
  vi.spyOn(client, "stream").mockImplementation(async function* (conversation) {
    await Promise.resolve();
    requests.push(JSON.stringify(conversation.getMessages()));
    yield* turns.shift() ?? [end];
  });
  vi.spyOn(clients, "createClient").mockResolvedValue(client);
});

afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  rmSync(workDir, { recursive: true, force: true });
});

function delegate(args: Record<string, unknown>): StreamEvent[] {
  return [
    {
      type: "tool_call_complete",
      toolName: "Agent",
      toolId: "worker",
      arguments: { description: "audit", prompt: "Inspect this", ...args },
    },
    { ...end, stopReason: "tool_use" },
  ];
}

async function* events(...items: AgentEvent[]): AsyncGenerator<AgentEvent> {
  await Promise.resolve();
  yield* items;
}

describe("print mode delegation", () => {
  it("forks the live conversation by default and injects project instructions", async () => {
    writeFileSync(join(workDir, "AGENTS.md"), "Keep the project constraint.");
    turns = [
      delegate({}),
      [{ type: "text_delta", text: "worker evidence" }, end],
      [end],
    ];
    await runPrintMode({ prompt: "Parent task", outputFormat: "text" });

    expect(requests).toHaveLength(3);
    expect(requests[0]).toContain("Keep the project constraint.");
    expect(requests[1]).toContain("Parent task");
    expect(requests[1]).toContain("fork_boilerplate");
    expect(requests[2]).toContain("worker evidence");
    expect(requests[2]).not.toContain("fork_boilerplate");
    expect(process.exitCode).toBe(0);
  });

  it.each([true, false])(
    "honors enable_fork=%s and forwards child execution context",
    async (fork) => {
      cfg.enable_fork = fork;
      const spawn = vi
        .spyOn(subagents, "spawnSubagent")
        .mockResolvedValue("worker evidence");
      turns = [delegate({}), [end]];
      await runPrintMode({ prompt: "Parent task", outputFormat: "text" });
      expect(spawn).toHaveBeenCalledOnce();
      expect(Boolean(spawn.mock.calls[0]?.[10]?.conversation)).toBe(fork);
      expect(spawn.mock.calls[0]?.[9]?.mode).toBe("bypassPermissions");
    },
  );

  it("passes background, model, cancellation, permissions and isolated cwd to spawn", async () => {
    const isolated = join(workDir, "isolated");
    vi.spyOn(worktrees, "createAgentWorktree").mockResolvedValue({
      path: isolated,
      branch: "worker",
      headCommit: "head",
      gitRoot: workDir,
    });
    const spawn = vi
      .spyOn(subagents, "spawnSubagent")
      .mockResolvedValue("worker evidence");
    const signal = new AbortController().signal;
    const onPermissionRequest: NonNullable<
      ToolContext["onPermissionRequest"]
    > = () => Promise.resolve("allow");
    // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked with the original receiver below
    const execute = AgentTool.prototype.execute;
    vi.spyOn(AgentTool.prototype, "execute").mockImplementation(function (
      this: AgentTool,
      ctx,
      args,
    ) {
      return execute.call(
        this,
        { ...ctx, abortSignal: signal, onPermissionRequest },
        args,
      );
    });
    turns = [
      delegate({
        subagent_type: "general-purpose",
        run_in_background: true,
        isolation: "worktree",
        model: "worker-model",
      }),
      [end],
    ];
    await runPrintMode({ prompt: "Parent task", outputFormat: "text" });

    const call = spawn.mock.calls[0];
    expect(call?.[5]).toBe(isolated);
    expect(call?.[8]).toBe("worker-model");
    expect(call?.[9]?.mode).toBe("bypassPermissions");
    expect(call?.[10]).toMatchObject({
      background: true,
      onPermissionRequest,
      permissionMode: "bypassPermissions",
    });
    expect(call?.[10]?.abortSignal).not.toBe(signal);
    expect(call?.[10]?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("passes member cwd and plan checker, and stops teammates before disconnecting MCP", async () => {
    const isolated = join(workDir, "isolated");
    vi.spyOn(backend, "detectBackend").mockReturnValue("in-process");
    vi.spyOn(worktrees, "createAgentWorktree").mockResolvedValue({
      path: isolated,
      branch: "worker",
      headCommit: "head",
      gitRoot: workDir,
    });
    const spawn = vi
      .spyOn(subagents, "spawnSubagent")
      .mockImplementation((...args) => {
        const signal = args[10]?.abortSignal;
        if (!signal) {
          return Promise.reject(
            new Error("Missing teammate cancellation signal"),
          );
        }
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new Error("stopped"));
            },
            {
              once: true,
            },
          );
        });
      });
    let stoppedBeforeDisconnect = false;
    disconnect.mockImplementation(() => {
      stoppedBeforeDisconnect =
        spawn.mock.calls[0]?.[10]?.abortSignal?.aborted === true;
      return Promise.resolve();
    });
    turns = [
      delegate({
        team_name: "audit",
        isolation: "worktree",
        plan_mode_required: true,
      }),
      [end],
    ];
    await runPrintMode({ prompt: "Parent task", outputFormat: "text" });

    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0]?.[5]).toBe(isolated);
    expect(spawn.mock.calls[0]?.[9]?.mode).toBe("plan");
    expect(spawn.mock.calls[0]?.[10]?.abortSignal?.aborted).toBe(true);
    expect(stoppedBeforeDisconnect).toBe(true);
    expect(disconnect).toHaveBeenCalledOnce();
  });
});

describe("print mode completion", () => {
  it.each(["text", "stream-json"] as const)(
    "sets a failed exit status for error events in %s",
    async (outputFormat) => {
      vi.spyOn(Agent.prototype, "run").mockImplementation(() =>
        events(
          { type: "stream_text", text: "partial" },
          { type: "error", error: new Error("provider failed") },
        ),
      );
      await runPrintMode({ prompt: "Task", outputFormat });

      expect(process.exitCode).toBe(1);
      expect(disconnect).toHaveBeenCalledOnce();
      if (outputFormat === "stream-json") {
        expect(console.log).toHaveBeenCalledWith(
          JSON.stringify({ type: "error", message: "provider failed" }),
        );
        expect(console.log).toHaveBeenLastCalledWith(
          expect.stringContaining('"result":"partial"'),
        );
      } else {
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining("provider failed"),
        );
      }
    },
  );

  it("marks an interrupted run as failed", async () => {
    vi.spyOn(Agent.prototype, "run").mockImplementation(() =>
      events({ type: "loop_complete", stopReason: "interrupted" }),
    );
    await runPrintMode({ prompt: "Task", outputFormat: "text" });
    expect(process.exitCode).toBe(1);
  });

  it("cleans up after a stream throws without masking the original error", async () => {
    vi.spyOn(Agent.prototype, "run").mockImplementation(() => {
      throw new Error("stream failed");
    });
    disconnect.mockRejectedValue(new Error("cleanup failed"));
    await expect(
      runPrintMode({ prompt: "Task", outputFormat: "text" }),
    ).rejects.toThrow("stream failed");
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("cleans up when MCP setup throws after opening connections", async () => {
    connect.mockRejectedValue(new Error("setup failed"));
    await expect(
      runPrintMode({ prompt: "Task", outputFormat: "text" }),
    ).rejects.toThrow("setup failed");
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("keeps successful output and status if MCP cleanup fails", async () => {
    disconnect.mockRejectedValue(new Error("cleanup failed"));
    await runPrintMode({ prompt: "Task", outputFormat: "text" });
    expect(stdoutWrite).toHaveBeenCalledWith("answer");
    expect(stdoutWrite).toHaveBeenLastCalledWith("\n");
    expect(process.exitCode).toBe(0);
  });
});
