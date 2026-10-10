import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

import type { AgentEvent } from "@/agent/events.js";
import { Agent } from "@/agent/index.js";
import * as config from "@/config/index.js";
import type { AppConfig } from "@/config/index.js";
import { GoalManager } from "@/goal/index.js";
import * as clients from "@/llm/client.js";
import type { StreamEvent } from "@/llm/events.js";
import { OpenAIClient } from "@/llm/openai.js";
import { MCPManager } from "@/mcp/manager.js";
import { parsePrintFlags, runPrintMode } from "@/print-mode.js";
import { createRemoteAgent } from "@/remote/server.js";
import { restoreRemoteSession } from "@/remote/session-state.js";
import {
  getSessionFilePath,
  loadSession,
  listSessions,
  rebuildFromSession,
  sessionLineCount,
  truncateSessionLines,
} from "@/session/index.js";
import { AgentTool } from "@/subagent/agent-tool.js";
import * as subagents from "@/subagent/spawn.js";
import { TaskManager } from "@/subagent/task-manager.js";
import type { ToolContext } from "@/tools/types.js";
import { contentToText } from "@/utils/index.js";
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

let cwd: string;
let cfg: AppConfig;
let turns: StreamEvent[][];
let requests: string[];
let toolNames: string[][];
let previousExitCode: typeof process.exitCode;
let disconnect: MockInstance<MCPManager["disconnectAll"]>;
let connect: MockInstance<MCPManager["connectAll"]>;
let stdoutWrite: MockInstance<typeof process.stdout.write>;

beforeEach(() => {
  cwd = mkdtempSync(join(os.tmpdir(), "yukino-print-"));
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  vi.mocked(os.homedir).mockReturnValue(cwd);
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
    default_provider: 0,
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
  toolNames = [];
  const client = new OpenAIClient(
    { ...cfg.providers[0], api_key: "test" },
    "system",
  );
  vi.spyOn(client, "stream").mockImplementation(
    async function* (conversation, schemas) {
      await Promise.resolve();
      requests.push(JSON.stringify(conversation.getMessages()));
      toolNames.push(
        schemas.map((schema) =>
          "name" in schema ? schema.name : schema.function.name,
        ),
      );
      yield* turns.shift() ?? [end];
    },
  );
  vi.spyOn(clients, "createClient").mockResolvedValue(client);
});

afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  rmSync(cwd, { recursive: true, force: true });
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

describe("host tracking interfaces", () => {
  it("uses TodoWrite throughout a non-interactive run and returns consistent progress", async () => {
    const todos = [{ subject: "work", status: "in_progress" }];
    turns = [
      [
        {
          type: "tool_call_complete",
          toolId: "todo-start",
          toolName: "TodoWrite",
          arguments: { todos },
        },
        { ...end, stopReason: "tool_use" },
      ],
      [
        {
          type: "tool_call_complete",
          toolId: "todo-done",
          toolName: "TodoWrite",
          arguments: {
            todos: [{ id: "1", subject: "work", status: "completed" }],
          },
        },
        { ...end, stopReason: "tool_use" },
      ],
      [end],
    ];
    await runPrintMode({
      prompt: "Do tracked work",
      outputFormat: "stream-json",
    });
    expect(toolNames).toHaveLength(3);
    for (const names of toolNames) {
      expect(names).toContain("TodoWrite");
      expect(
        names.some((name) =>
          /^(TaskCreate|TaskGet|TaskList|TaskUpdate)$/u.test(name),
        ),
      ).toBe(false);
    }
    expect(requests[1]).toContain("TODO 0/1");
    expect(requests[2]).toContain("TODO 1/1");
    expect(process.exitCode).toBe(0);
  });

  it.each(["interactive", "non-interactive"] as const)(
    "builds remote runtimes with the explicit %s interface",
    async (interactionMode) => {
      const handle = await createRemoteAgent({
        provider: cfg.providers[0],
        cwd,
        interactionMode,
        enableCoordinatorMode: false,
        forkDisabled: false,
        memoryEnabled: false,
      });
      try {
        expect(handle.registry.get("TodoWrite") !== undefined).toBe(
          interactionMode === "non-interactive",
        );
        expect(handle.registry.get("TaskCreate") !== undefined).toBe(
          interactionMode === "interactive",
        );
      } finally {
        await handle.registry.dispose();
        await handle.teamManager.dispose();
      }
    },
  );
});

function failingBackgroundClient(dispatchFromLeader: boolean): OpenAIClient {
  let leaderCalls = 0;
  let childCalls = 0;
  const llm = new OpenAIClient(
    { ...cfg.providers[0], api_key: "test" },
    "system",
  );
  vi.spyOn(llm, "stream").mockImplementation(async function* (conversation) {
    await Promise.resolve();
    const isChild = conversation
      .getMessages()
      .some((message) =>
        contentToText(message.content).includes("unique-child-assignment"),
      );
    if (isChild) {
      if (childCalls++ > 0) {
        throw new Error("model disconnected");
      }
      yield { type: "text_delta", text: "partial verification report" };
      yield {
        type: "tool_call_complete",
        toolId: "read-proof",
        toolName: "ReadFile",
        arguments: { file_path: "proof.txt" },
      };
      yield { ...end, stopReason: "tool_use" };
    } else if (dispatchFromLeader && leaderCalls++ === 0) {
      yield* delegate({
        description: "original dispatch",
        prompt: "unique-child-assignment",
        subagent_type: "general-purpose",
        run_in_background: true,
      });
    } else {
      yield { type: "text_delta", text: "leader response" };
      yield end;
    }
  });
  return llm;
}

describe("durable background outcomes across hosts", () => {
  it("keeps print-mode transcripts and task results after exit", async () => {
    writeFileSync(join(cwd, "proof.txt"), "verified file contents");
    vi.mocked(clients.createClient).mockResolvedValue(
      failingBackgroundClient(true),
    );
    await runPrintMode({
      prompt: "delegate work",
      outputFormat: "stream-json",
    });
    const sessions = listSessions(cwd);
    expect(sessions).toHaveLength(1);
    const tasks = new TaskManager(sessions[0].id);
    const task = tasks.list()[0];
    expect(task.status).toBe("failed");
    expect(task.output).toContain("partial verification report");
    expect(task.transcriptPath).toBeDefined();
    const transcript = task.transcriptPath ?? "";
    expect(existsSync(transcript)).toBe(true);
    expect(readFileSync(transcript, "utf8")).toContain(
      "verified file contents",
    );
    const replay = rebuildFromSession(loadSession(cwd, sessions[0].id));
    expect(
      replay.filter((message) =>
        contentToText(message.content).includes(
          `<task-notification task_id="${task.id}"`,
        ),
      ),
    ).toHaveLength(1);
    expect(tasks.hasNotifications()).toBe(false);
  });

  it.each(["defined", "fork"])(
    "preserves %s background failures in the remote runtime",
    async (route) => {
      writeFileSync(join(cwd, "proof.txt"), "verified file contents");
      vi.mocked(clients.createClient).mockResolvedValue(
        failingBackgroundClient(false),
      );
      const handle = await createRemoteAgent({
        provider: cfg.providers[0],
        cwd,
        enableCoordinatorMode: false,
        forkDisabled: false,
        memoryEnabled: false,
      });
      try {
        const tool = handle.registry.get("Agent");
        if (!tool) {
          throw new Error("Missing Agent tool");
        }
        const result = await tool.execute(
          {
            cwd,
            sessionId: handle.sessionId,
            taskManager: handle.backgroundTaskManager,
          },
          {
            description: "original dispatch",
            prompt: "unique-child-assignment",
            run_in_background: true,
            ...(route === "defined"
              ? { subagent_type: "general-purpose" }
              : {}),
          },
        );
        expect(result.isError).toBe(false);
        const task = handle.backgroundTaskManager.list()[0];
        await task.done;
        expect(task.status).toBe("failed");
        expect(task.output).toContain("partial verification report");
        const transcript = task.transcriptPath ?? "";
        expect(existsSync(transcript)).toBe(true);
        expect(readFileSync(transcript, "utf8")).toContain(
          "verified file contents",
        );
        for await (const event of handle.run("inspect outcomes", {
          onPermissionRequest: () => Promise.resolve("allow"),
        })) {
          expect(event.type).not.toBe("error");
        }
        expect(
          rebuildFromSession(loadSession(cwd, handle.sessionId)).some(
            (message) =>
              contentToText(message.content).includes(
                `<task-notification task_id="${task.id}"`,
              ),
          ),
        ).toBe(true);
        expect(new TaskManager(handle.sessionId).get(task.id)?.output).toBe(
          task.output,
        );
        expect(new TaskManager(handle.sessionId).hasNotifications()).toBe(
          false,
        );
      } finally {
        await handle.backgroundTaskManager.stopAll();
        await handle.registry.dispose();
        await handle.teamManager.dispose();
      }
    },
  );
});

describe("print mode argument parsing", () => {
  it("respects -- and treats flag-like prompt text as data", () => {
    expect(parsePrintFlags(["--", "-p", "task"])).toBeNull();
    expect(
      parsePrintFlags(["-p", "--", "--output-format", "stream-json"]),
    ).toEqual({ prompt: "--output-format", outputFormat: "text" });
    expect(
      parsePrintFlags(["--output-format", "stream-json", "-p", "--", "--acp"]),
    ).toEqual({ prompt: "--acp", outputFormat: "stream-json" });
  });

  it.each([
    ["has no following argument", ["-p"]],
    [
      "is immediately followed by another flag",
      ["-p", "--output-format", "stream-json", "actual prompt"],
    ],
  ])("rejects -p when it %s", (_label, args) => {
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });

    expect(() => parsePrintFlags(args)).toThrow("exit 1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("requires a prompt argument immediately"),
    );
  });

  it.each([
    ["is missing", ["-p", "prompt", "--output-format"]],
    ["is invalid", ["-p", "prompt", "--output-format", "json"]],
  ])("rejects --output-format when its value %s", (_label, args) => {
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });

    expect(() => parsePrintFlags(args)).toThrow("exit 1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("requires 'text' or 'stream-json'"),
    );
  });
});

describe("goal host commands", () => {
  it.each(["/goal", "/goal --budget 0 Invalid"])(
    "handles %s locally with a final JSONL result",
    async (prompt) => {
      await runPrintMode({ prompt, outputFormat: "stream-json" });
      expect(clients.createClient).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenLastCalledWith(
        expect.stringContaining('"num_turns":0'),
      );
      expect(process.exitCode).toBe(prompt === "/goal" ? 0 : 1);
    },
  );
  it("sets and completes a persistent goal through print mode", async () => {
    turns = [
      [
        {
          type: "tool_call_complete",
          toolId: "goal",
          toolName: "Goal",
          arguments: {
            action: "update",
            status: "complete",
            reason: "Verified requested result",
          },
        },
        { ...end, stopReason: "tool_use" },
      ],
      [{ type: "text_delta", text: "Verified" }, end],
    ];
    await runPrintMode({
      prompt: "/goal --budget 100 Finish requested work",
      outputFormat: "stream-json",
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain("Finish requested work");
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('"type":"goal"'),
    );
    expect(stdoutWrite).not.toHaveBeenCalledWith(
      expect.stringContaining("Error:"),
    );
    expect(process.exitCode).toBe(0);
  });
  it("uses the same goal state for remote runs and reloads it on same-session restore", async () => {
    const handle = await createRemoteAgent({
      provider: cfg.providers[0],
      cwd,
      enableCoordinatorMode: false,
      forkDisabled: false,
      memoryEnabled: false,
      sessionId: "remote-goal",
    });
    const collect = async (text: string) => {
      const output: AgentEvent[] = [];
      for await (const event of handle.run(text, {
        onPermissionRequest: () => Promise.resolve("allow"),
      })) {
        output.push(event);
      }
      return output;
    };
    try {
      await collect("/goal");
      expect(requests).toHaveLength(0);
      const manager = handle.goalManager;
      expect(manager).toBeInstanceOf(GoalManager);
      if (!manager) {
        throw new Error("Missing goal manager");
      }
      manager.set("First objective");
      const path = getSessionFilePath(cwd, handle.sessionId);
      const lines = sessionLineCount(path);
      manager.set("Second objective", null, true);
      if (lines === undefined) {
        throw new Error("Missing transcript");
      }
      truncateSessionLines(path, lines);
      restoreRemoteSession(
        handle,
        handle.sessionId,
        loadSession(cwd, handle.sessionId),
      );
      expect(handle.goalManager?.get()?.objective).toBe("First objective");
      await collect("/goal pause");
      expect(handle.goalManager?.get()?.status).toBe("paused");
      turns = [
        [
          {
            type: "tool_call_complete",
            toolId: "goal",
            toolName: "Goal",
            arguments: {
              action: "update",
              status: "complete",
              reason: "Verified requested result",
            },
          },
          { ...end, stopReason: "tool_use" },
        ],
        [end],
      ];
      await collect("/goal resume");
      expect(handle.goalManager?.get()).toMatchObject({
        status: "complete",
        tokensUsed: 6,
      });
    } finally {
      await handle.teamManager.dispose();
      await handle.registry.dispose();
    }
  });
});

describe("print mode provider selection", () => {
  it("runs with the provider recorded as default_provider", async () => {
    cfg.default_provider = 1;
    cfg.providers.push({
      name: "second",
      protocol: "openai",
      model: "second-model",
      base_url: "https://second.invalid",
    });
    await runPrintMode({ prompt: "Parent task", outputFormat: "text" });
    expect(vi.mocked(clients.createClient).mock.calls[0]?.[0]).toMatchObject({
      base_url: "https://second.invalid",
    });
    expect(process.exitCode).toBe(0);
  });

  it("falls back to the first provider when default_provider is out of range", async () => {
    cfg.default_provider = 9;
    await runPrintMode({ prompt: "Parent task", outputFormat: "text" });
    expect(vi.mocked(clients.createClient).mock.calls[0]?.[0]).toMatchObject({
      base_url: "https://test.invalid",
    });
  });
});

describe("print mode delegation", () => {
  it("forks the live conversation by default and injects project instructions", async () => {
    writeFileSync(join(cwd, "AGENTS.md"), "Keep the project constraint.");
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
    const isolated = join(cwd, "isolated");
    vi.spyOn(worktrees, "createAgentWorktree").mockResolvedValue({
      path: isolated,
      branch: "worker",
      headCommit: "head",
      gitRoot: cwd,
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

  it("derives a stable teammate name from an unsafe description", async () => {
    const spawn = vi
      .spyOn(subagents, "spawnSubagent")
      .mockResolvedValue("done");
    turns = [
      delegate({ team_name: "audit", description: "Audit API/routes" }),
      [end],
    ];

    await runPrintMode({ prompt: "Parent task", outputFormat: "text" });

    expect(spawn.mock.calls[0]?.[1]).toContain('You are "audit-api_routes"');
    expect(spawn.mock.calls[0]?.[9]?.mode).toBe("bypassPermissions");
  });

  it("rejects an invalid explicit teammate name before spawning", async () => {
    const spawn = vi
      .spyOn(subagents, "spawnSubagent")
      .mockResolvedValue("done");
    turns = [delegate({ team_name: "audit", name: "api/reviewer" }), [end]];

    await runPrintMode({ prompt: "Parent task", outputFormat: "text" });

    expect(spawn).not.toHaveBeenCalled();
  });

  it("passes an explicit teammate name and worktree with parent mode precedence", async () => {
    const isolated = join(cwd, "isolated");
    vi.spyOn(worktrees, "createAgentWorktree").mockResolvedValue({
      path: isolated,
      branch: "worker",
      headCommit: "head",
      gitRoot: cwd,
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
        name: "core-scout",
        isolation: "worktree",
        plan_mode_required: true,
      }),
      [end],
    ];
    await runPrintMode({ prompt: "Parent task", outputFormat: "text" });

    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0]?.[1]).toContain('You are "core-scout"');
    expect(spawn.mock.calls[0]?.[5]).toBe(isolated);
    expect(spawn.mock.calls[0]?.[9]?.mode).toBe("bypassPermissions");
    expect(spawn.mock.calls[0]?.[10]?.abortSignal?.aborted).toBe(true);
    expect(stoppedBeforeDisconnect).toBe(true);
    expect(disconnect).toHaveBeenCalledOnce();
  });
});

describe("print mode completion", () => {
  it("streams linear JSONL deltas and pairs concurrent same-name tools by call ID", async () => {
    vi.spyOn(Agent.prototype, "run").mockImplementation(() =>
      events(
        { type: "thinking_text", text: "Inspecting" },
        { type: "stream_text", text: "Hello " },
        { type: "stream_text", text: "world" },
        { type: "tool_use", toolName: "ReadFile", toolId: "first", args: {} },
        { type: "tool_use", toolName: "ReadFile", toolId: "second", args: {} },
        {
          type: "tool_result",
          toolName: "ReadFile",
          toolId: "first",
          output: "a",
          isError: false,
          elapsed: 1,
        },
        {
          type: "tool_result",
          toolName: "ReadFile",
          toolId: "second",
          output: "b",
          isError: false,
          elapsed: 2,
        },
        {
          type: "usage",
          usage: {
            inputTokens: 2,
            outputTokens: 3,
            cacheReadInputTokens: 4,
            cacheCreationInputTokens: 5,
          },
        },
        { type: "loop_complete", stopReason: "end_turn" },
      ),
    );
    await runPrintMode({ prompt: "Task", outputFormat: "stream-json" });
    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({ type: "stream_text", text: "Hello " }),
    );
    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({ type: "stream_text", text: "world" }),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('"tool_id":"first","output":"a"'),
    );
    const final: unknown = vi.mocked(console.log).mock.calls.at(-1)?.[0];
    expect(typeof final).toBe("string");
    if (typeof final !== "string") {
      throw new Error("Missing JSONL result");
    }
    const result: unknown = JSON.parse(final);
    expect(result).toMatchObject({
      type: "result",
      result: "Hello world",
      tool_calls: [
        { tool_id: "first", elapsed: 1 },
        { tool_id: "second", elapsed: 2 },
      ],
      usage: {
        inputTokens: 2,
        outputTokens: 3,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 5,
      },
    });
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "preserves %s exit status after the interrupted event and removes listeners",
    async (signal, code) => {
      const before = process.listenerCount(signal);
      vi.spyOn(Agent.prototype, "run").mockImplementation(async function* () {
        await Promise.resolve();
        process.emit(signal);
        yield { type: "loop_complete", stopReason: "interrupted" };
      });
      await runPrintMode({ prompt: "Task", outputFormat: "text" });
      expect(process.exitCode).toBe(code);
      expect(process.listenerCount(signal)).toBe(before);
    },
  );

  it("cancels background subagents when interrupted while waiting for their results", async () => {
    const spawn = vi
      .spyOn(subagents, "spawnSubagent")
      .mockImplementation((...args) => {
        const signal = args[10]?.abortSignal;
        if (!signal) {
          throw new Error("Missing child cancellation signal");
        }
        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              resolve("Stopped");
            },
            { once: true },
          );
          setImmediate(() => {
            process.emit("SIGINT");
          });
        });
      });
    turns = [
      delegate({ subagent_type: "explore", run_in_background: true }),
      [end],
    ];
    await runPrintMode({ prompt: "Parent task", outputFormat: "text" });
    expect(process.exitCode).toBe(130);
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0]?.[10]?.abortSignal?.aborted).toBe(true);
    expect(disconnect).toHaveBeenCalledOnce();
  });

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
