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
import * as invocation from "@/bootstrap/invocation.js";
import * as config from "@/config/index.js";
import type { AppConfig } from "@/config/index.js";
import { RuntimePreferencesSchema } from "@/config/preferences.js";
import { GoalManager } from "@/goal/index.js";
import * as clients from "@/llm/client.js";
import type { StreamEvent } from "@/llm/events.js";
import { OpenAIClient } from "@/llm/openai.js";
import { MCPManager } from "@/mcp/manager.js";
import * as mcpStrategy from "@/mcp/strategy.js";
import { savePlan } from "@/plan-file/index.js";
import { runPrintMode } from "@/print/index.js";
import { createRuntimeEnvironment } from "@/remote/runtime-environment.js";
import { createAgentRuntime } from "@/runtime/factory.js";
import { AgentSession, createAgentSession } from "@/sdk/index.js";
import {
  loadSession,
  listSessions,
  rebuildFromSession,
} from "@/session/index.js";
import { SessionManager } from "@/session/manager.js";
import { AgentTool } from "@/subagent/agent-tool.js";
import * as subagents from "@/subagent/spawn.js";
import { TaskManager } from "@/subagent/task-manager.js";
import { TeamManager } from "@/teams/index.js";
import { ExitPlanModeTool } from "@/tools/exit-plan-mode.js";
import { ToolRegistry } from "@/tools/registry.js";
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
let stderrWrite: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  cwd = mkdtempSync(join(os.tmpdir(), "yukino-print-"));
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  vi.mocked(os.homedir).mockReturnValue(cwd);
  stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
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
    ...RuntimePreferencesSchema.parse({}),
    theme: "auto",
    providers: [
      {
        name: "test",
        protocol: "openai",
        model: "test",
        base_url: "https://test.invalid",
      },
    ],
    hooks: [],
    mcp_servers: [],
    permission_mode: "bypassPermissions",
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
  vi.spyOn(clients, "createClient").mockImplementation((provider) =>
    Promise.resolve(mockClient(client, provider)),
  );
});

afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  rmSync(cwd, { recursive: true, force: true });
});

it("uses the internal MCP wire adapter in print mode", async () => {
  const decide = vi.spyOn(mcpStrategy, "decideAndApply");
  await runPrintMode({ prompt: "hello", outputFormat: "text" });
  expect(decide).toHaveBeenCalledWith(
    expect.anything(),
    cfg.providers[0].base_url,
    cfg.providers[0].protocol,
  );
});

function mockClient(client: OpenAIClient, provider = cfg.providers[0]) {
  const measured = clients.measureClient(
    {
      protocol: client.protocol,
      stream: (...args) => client.stream(...args),
      setSystemPrompt: (prompt) => {
        client.setSystemPrompt(prompt);
      },
    },
    provider,
  );
  const mock = new OpenAIClient({ ...provider, api_key: "test" }, "system");
  vi.spyOn(mock, "stream").mockImplementation((...args) =>
    measured.stream(...args),
  );
  return mock;
}

function delegate(args: Record<string, unknown>): StreamEvent[] {
  return [
    {
      type: "tool_call_complete",
      toolName: "Agent",
      toolId: "worker",
      arguments: {
        kind: "subagent",
        description: "audit",
        prompt: "Inspect this",
        ...args,
      },
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
    expect(requests[1]).toContain("DONE 0/1");
    expect(requests[2]).toContain("DONE 1/1");
    expect(process.exitCode).toBe(0);
  });

  it.each(["interactive", "non-interactive"] as const)(
    "builds remote runtimes with the explicit %s interface",
    async (interactionMode) => {
      const handle = await createAgentRuntime({
        provider: cfg.providers[0],
        cwd,
        interactionMode,
        enableCoordinatorMode: false,
        memoryEnabled: false,
      });
      try {
        expect(handle.registry.get("TodoWrite")).toBeDefined();
        for (const name of [
          "TaskCreate",
          "TaskGet",
          "TaskList",
          "TaskUpdate",
        ]) {
          expect(handle.registry.get(name)).toBeUndefined();
        }
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
        kind: "subagent",
        description: "original dispatch",
        prompt: "unique-child-assignment",
        subagent_type: "general-purpose",
        fork: false,
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
      mockClient(failingBackgroundClient(true)),
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
        mockClient(failingBackgroundClient(false)),
      );
      const handle = await createAgentRuntime({
        provider: cfg.providers[0],
        cwd,
        enableCoordinatorMode: false,
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
            kind: "subagent",
            description: "original dispatch",
            prompt: "unique-child-assignment",
            run_in_background: true,
            ...(route === "defined"
              ? { subagent_type: "general-purpose", fork: false }
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

describe("goal host commands", () => {
  it.each(["/goal", "/goal --budget 0 Invalid"])(
    "handles %s locally with a final JSONL result",
    async (prompt) => {
      await runPrintMode({ prompt, outputFormat: "stream-json" });
      expect(requests).toHaveLength(0);
      expect(connect).not.toHaveBeenCalled();
      expect(stdoutWrite).toHaveBeenLastCalledWith(
        containingText('"num_turns":0'),
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
    expect(jsonLines()).toContainEqual(
      matching({
        type: "tool_result",
        payload: matching({
          toolName: "Goal",
          isError: false,
          output: containingText("Status: complete"),
        }),
      }),
    );
    expect(stdoutWrite).not.toHaveBeenCalledWith(containingText("Error:"));
    expect(process.exitCode).toBe(0);
  });
  it("uses the same goal state for remote runs and reloads it on same-session restore", async () => {
    const session = SessionManager.create(cwd);
    const openEnvironment = () =>
      createRuntimeEnvironment(cfg, session, {
        enableCoordinatorMode: false,
        memoryEnabled: false,
      });
    let environment = await openEnvironment();
    let handle = environment.runtime;
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
      const leaf = SessionManager.open(cwd, handle.sessionId).leafId;
      manager.set("Second objective", null, true);
      if (leaf === null) {
        throw new Error("Missing transcript");
      }
      SessionManager.open(cwd, handle.sessionId).navigate(leaf);
      await Promise.all([environment.project.dispose(), handle.dispose()]);
      environment = await openEnvironment();
      handle = environment.runtime;
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
      await Promise.all([environment.project.dispose(), handle.dispose()]);
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

  it("falls back to the first provider if the default index is out of range", async () => {
    cfg.default_provider = 9;
    await runPrintMode({ prompt: "Parent task", outputFormat: "text" });
    expect(vi.mocked(clients.createClient).mock.calls[0]?.[0]?.name).toBe(
      cfg.providers[0]?.name,
    );
    expect(requests).toHaveLength(1);
    expect(process.exitCode).toBe(0);
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
    expect(requests[1]).toContain("general-purpose");
    expect(requests[2]).toContain("worker evidence");
    expect(requests[2]).not.toContain(
      "Complete the assigned task and return your result to the parent agent.",
    );
    expect(process.exitCode).toBe(0);
  });

  it("forks by default and forwards child execution context", async () => {
    const spawn = vi
      .spyOn(subagents, "spawnSubagent")
      .mockResolvedValue("worker evidence");
    turns = [delegate({}), [end]];
    await runPrintMode({ prompt: "Parent task", outputFormat: "text" });
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0]?.[10]?.contextSnapshot).toBeDefined();
    expect(spawn.mock.calls[0]?.[9]?.mode).toBe("bypassPermissions");
  });

  it("passes background, model, cancellation, permissions and isolated cwd to spawn", async () => {
    const isolated = join(cwd, "isolated");
    vi.spyOn(worktrees.OwnedWorktrees.prototype, "register").mockResolvedValue(
      true,
    );
    vi.spyOn(worktrees, "createAgentWorktree").mockResolvedValue({
      created: true,
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
        fork: false,
        run_in_background: true,
        worktree: true,
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
      delegate({ kind: "teammate", description: "Audit API/routes" }),
      [end],
    ];

    await runPrintMode({ prompt: "Parent task", outputFormat: "text" });

    expect(spawn.mock.calls[0]?.[1]).toContain('You are "audit-api_routes"');
    expect(spawn.mock.calls[0]?.[9]?.mode).toBe("bypassPermissions");
  });

  it("generates a safe teammate name from a non-ASCII description", async () => {
    const spawn = vi
      .spyOn(subagents, "spawnSubagent")
      .mockResolvedValue("done");
    turns = [delegate({ kind: "teammate", description: "审查 API" }), [end]];

    await runPrintMode({ prompt: "Parent task", outputFormat: "text" });

    expect(spawn.mock.calls[0]?.[1]).toContain('You are "__-api"');
  });

  it("passes an automatically generated teammate name and worktree with parent mode precedence", async () => {
    const isolated = join(cwd, "isolated");
    vi.spyOn(worktrees.OwnedWorktrees.prototype, "register").mockResolvedValue(
      true,
    );
    vi.spyOn(worktrees, "createAgentWorktree").mockResolvedValue({
      created: true,
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
          setImmediate(() => {
            process.emit("SIGINT");
          });
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
        kind: "teammate",
        description: "core scout",
        worktree: true,
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

function matching(value: unknown): unknown {
  return expect.objectContaining(value);
}
function anyValue(type: Parameters<typeof expect.any>[0]): unknown {
  return expect.any(type);
}
function containingText(value: string): unknown {
  return expect.stringContaining(value);
}

function jsonLines(): unknown[] {
  return stdoutWrite.mock.calls.flatMap(([chunk]) =>
    String(chunk)
      .split("\n")
      .filter(Boolean)
      .map((line): unknown => JSON.parse(line)),
  );
}

function finalResult(): unknown {
  return jsonLines().at(-1);
}

function pendingDelegate() {
  return vi.spyOn(subagents, "spawnSubagent").mockImplementation((...args) => {
    const signal = args[10]?.abortSignal;
    if (!signal) {
      throw new Error("Missing child cancellation signal");
    }
    return new Promise<string>((resolve) => {
      signal.addEventListener(
        "abort",
        () => {
          resolve("Stopped");
        },
        { once: true },
      );
    });
  });
}

function backgroundTurn(): void {
  turns = [
    delegate({
      subagent_type: "explore",
      fork: false,
      run_in_background: true,
    }),
    [end],
  ];
}

describe("print mode completion", () => {
  it("streams typed session events and pairs concurrent same-name tools by call ID", async () => {
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
    const lines = jsonLines();
    expect(lines).toContainEqual(
      matching({
        type: "stream_text",
        sequence: anyValue(Number),
        sessionId: anyValue(String),
        runId: anyValue(String),
        source: "agent",
        payload: { text: "Hello " },
      }),
    );
    expect(lines).toContainEqual(
      matching({
        type: "stream_text",
        payload: { text: "world" },
      }),
    );
    for (const [toolId, output] of [
      ["first", "a"],
      ["second", "b"],
    ]) {
      expect(lines).toContainEqual(
        matching({
          type: "tool_result",
          payload: matching({ toolId, output }),
        }),
      );
    }
    expect(lines.at(-2)).toMatchObject({ type: "disposed" });
    expect(finalResult()).toMatchObject({
      type: "result",
      status: "completed",
      result: "Hello world",
      tool_calls: ["ReadFile", "ReadFile"],
      usage: {
        inputTokens: 2,
        outputTokens: 3,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 5,
      },
    });
    expect(
      lines.filter(
        (line) =>
          typeof line === "object" &&
          line !== null &&
          "type" in line &&
          line.type === "result",
      ),
    ).toHaveLength(1);
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "preserves %s exit status and removes listeners",
    async (signal, code) => {
      const before = process.listenerCount(signal);
      vi.spyOn(Agent.prototype, "run").mockImplementation(async function* () {
        await Promise.resolve();
        process.emit(signal);
        yield { type: "loop_complete", stopReason: "interrupted" };
      });
      await runPrintMode({ prompt: "Task", outputFormat: "stream-json" });
      expect(process.exitCode).toBe(code);
      expect(finalResult()).toMatchObject({
        status: "aborted",
        stop_reason: "interrupted",
      });
      expect(process.listenerCount(signal)).toBe(before);
    },
  );

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "cancels owned background agents on %s while waiting",
    async (signal, code) => {
      const spawn = pendingDelegate();
      backgroundTurn();
      const wait = vi.spyOn(TaskManager.prototype, "wait");
      // eslint-disable-next-line @typescript-eslint/unbound-method -- called with its receiver
      const waitForBackground = AgentSession.prototype.waitForBackground;
      vi.spyOn(AgentSession.prototype, "waitForBackground").mockImplementation(
        function (this: AgentSession, options) {
          setImmediate(() => {
            process.emit(signal);
          });
          return waitForBackground.call(this, options);
        },
      );
      await runPrintMode({
        prompt: "Parent task",
        outputFormat: "stream-json",
      });
      expect(process.exitCode).toBe(code);
      expect(wait).toHaveBeenCalledWith(
        anyValue(String),
        matching({ abortSignal: anyValue(AbortSignal) }),
      );
      expect(spawn).toHaveBeenCalledOnce();
      expect(spawn.mock.calls[0]?.[10]?.abortSignal?.aborted).toBe(true);
      expect(finalResult()).toMatchObject({
        status: "aborted",
        tasks: [matching({ status: "cancelled" })],
      });
      expect(disconnect).toHaveBeenCalledOnce();
    },
  );

  it.each(["text", "stream-json"] as const)(
    "reports provider errors and keeps partial output in %s",
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
        expect(jsonLines()).toContainEqual(
          matching({
            type: "error",
            payload: { error: { name: "Error", message: "provider failed" } },
          }),
        );
        expect(finalResult()).toMatchObject({
          status: "failed",
          result: "partial",
          error: { message: "provider failed" },
        });
      } else {
        expect(stderrWrite).toHaveBeenCalledWith(
          containingText("provider failed"),
        );
        expect(stdoutWrite).toHaveBeenCalledWith("partial");
      }
    },
  );

  it("uses 130 for a generic interrupted result", async () => {
    vi.spyOn(Agent.prototype, "run").mockImplementation(() =>
      events({ type: "loop_complete", stopReason: "interrupted" }),
    );
    await runPrintMode({ prompt: "Task", outputFormat: "text" });
    expect(process.exitCode).toBe(130);
  });

  it.each(["text", "stream-json"] as const)(
    "does not mask execution errors with cleanup failures in %s",
    async (outputFormat) => {
      vi.spyOn(Agent.prototype, "run").mockImplementation(() => {
        throw new Error("stream failed");
      });
      disconnect.mockRejectedValue(new Error("cleanup failed"));
      await expect(
        runPrintMode({ prompt: "Task", outputFormat }),
      ).rejects.toThrow("stream failed");
      expect(disconnect).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(1);
      if (outputFormat === "stream-json") {
        expect(finalResult()).toMatchObject({
          status: "failed",
          error: { message: "stream failed" },
          cleanup_errors: anyValue(Array),
        });
        expect(JSON.stringify(finalResult())).toContain("cleanup failed");
      } else {
        expect(stderrWrite).toHaveBeenCalledWith(
          containingText("stream failed"),
        );
        expect(stderrWrite).toHaveBeenCalledWith(
          containingText("cleanup failed"),
        );
      }
    },
  );

  it("cleans up an initialization failure at the SDK environment boundary", async () => {
    vi.spyOn(mcpStrategy, "decideAndApply").mockImplementation(() => {
      throw new Error("setup failed");
    });
    await expect(
      runPrintMode({ prompt: "Task", outputFormat: "stream-json" }),
    ).rejects.toThrow("setup failed");
    expect(disconnect).toHaveBeenCalledOnce();
    expect(finalResult()).toMatchObject({
      status: "failed",
      num_turns: 0,
      error: { message: "setup failed" },
    });
    expect(requests).toHaveLength(0);
  });

  it.each(["text", "stream-json"] as const)(
    "never emits final success before a cleanup failure in %s",
    async (outputFormat) => {
      disconnect.mockRejectedValue(new Error("cleanup failed"));
      await expect(
        runPrintMode({ prompt: "Task", outputFormat }),
      ).rejects.toThrow("Session cleanup failed");
      expect(process.exitCode).toBe(1);
      if (outputFormat === "stream-json") {
        expect(finalResult()).toMatchObject({
          type: "result",
          status: "failed",
          result: "answer",
          cleanup_errors: anyValue(Array),
        });
        expect(JSON.stringify(finalResult())).toContain("cleanup failed");
        expect(
          jsonLines().filter(
            (line) =>
              typeof line === "object" &&
              line !== null &&
              "type" in line &&
              line.type === "result",
          ),
        ).toHaveLength(1);
      } else {
        expect(stdoutWrite).toHaveBeenCalledWith("answer");
        expect(stderrWrite).toHaveBeenCalledWith(
          containingText("cleanup failed"),
        );
      }
    },
  );

  it("preserves SIGTERM status even when cleanup fails", async () => {
    vi.spyOn(Agent.prototype, "run").mockImplementation(async function* () {
      await Promise.resolve();
      process.emit("SIGTERM");
      yield { type: "loop_complete", stopReason: "interrupted" };
    });
    disconnect.mockRejectedValue(new Error("cleanup failed"));
    await expect(
      runPrintMode({ prompt: "Task", outputFormat: "stream-json" }),
    ).rejects.toThrow("Session cleanup failed");
    expect(process.exitCode).toBe(143);
    expect(finalResult()).toMatchObject({
      status: "aborted",
      cleanup_errors: anyValue(Array),
    });
  });
});

describe("bounded owned background work", () => {
  it("keeps SDK waitForIdle foreground-only and times out finite jobs through TaskManager.wait", async () => {
    const spawn = pendingDelegate();
    backgroundTurn();
    const { session } = await createAgentSession({
      cwd,
      config: cfg,
      permissions: "bypassPermissions",
      persist: false,
    });
    try {
      const result = await session.prompt("delegate");
      await session.waitForIdle();
      expect(result.status).toBe("completed");
      expect(session.getTasks()).toEqual([matching({ status: "running" })]);
      const wait = vi.spyOn(TaskManager.prototype, "wait");
      const background = await session.waitForBackground({ timeoutMs: 0 });
      expect(background.timedOut).toBe(true);
      expect(wait).toHaveBeenCalledWith(anyValue(String), {
        timeoutMs: 0,
        abortSignal: anyValue(AbortSignal),
      });
      expect(spawn.mock.calls[0]?.[10]?.abortSignal?.aborted).toBe(true);
      expect(background.tasks).toEqual([matching({ status: "cancelled" })]);
      expect(
        session
          .getMessages()
          .some((message) =>
            contentToText(message.content).includes("<task-notification"),
          ),
      ).toBe(true);
    } finally {
      await session.dispose();
    }
  });

  it("makes a print background timeout a failed terminal result", async () => {
    const spawn = pendingDelegate();
    backgroundTurn();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with its receiver
    const wait = AgentSession.prototype.waitForBackground;
    vi.spyOn(AgentSession.prototype, "waitForBackground").mockImplementation(
      function (this: AgentSession, options) {
        return wait.call(this, { ...options, timeoutMs: 0 });
      },
    );
    await runPrintMode({ prompt: "delegate", outputFormat: "stream-json" });
    expect(finalResult()).toMatchObject({
      status: "failed",
      background_timed_out: true,
      tasks: [matching({ status: "cancelled" })],
    });
    expect(process.exitCode).toBe(1);
    expect(spawn.mock.calls[0]?.[10]?.abortSignal?.aborted).toBe(true);
  });

  it("waits for a newly launched Workflow and aggregates main and child costs only once", async () => {
    const client = new OpenAIClient(
      { ...cfg.providers[0], api_key: "test" },
      "system",
    );
    let mainCalls = 0;
    vi.spyOn(client, "stream").mockImplementation(
      async function* (conversation) {
        await Promise.resolve();
        const isChild = conversation
          .getMessages()
          .some((message) =>
            contentToText(message.content).includes(
              "workflow-child-assignment",
            ),
          );
        if (isChild) {
          yield { type: "text_delta", text: "workflow evidence" };
          yield end;
        } else if (mainCalls++ === 0) {
          yield {
            type: "tool_call_complete",
            toolName: "Workflow",
            toolId: "workflow",
            arguments: {
              script: 'return await agent("workflow-child-assignment")',
            },
          };
          yield { ...end, stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "leader done" };
          yield end;
        }
      },
    );
    vi.mocked(clients.createClient).mockResolvedValue(mockClient(client));
    const wait = vi.spyOn(TaskManager.prototype, "wait");
    await runPrintMode({ prompt: "workflow", outputFormat: "stream-json" });
    expect(wait).toHaveBeenCalledWith(
      containingText("workflow-"),
      matching({ abortSignal: anyValue(AbortSignal) }),
    );
    expect(finalResult()).toMatchObject({
      status: "completed",
      tasks: [
        matching({
          kind: "workflow",
          status: "completed",
          output: containingText("workflow evidence"),
        }),
      ],
      workflows: [matching({ status: "completed" })],
      usage: { inputTokens: 3, outputTokens: 6 },
      cost: {
        attempts: 3,
        requests: 3,
        usage: { inputTokens: 3, outputTokens: 6 },
      },
    });
    expect(process.exitCode).toBe(0);
  });

  it("does not wait for a shell dev server and still cleans it up", async () => {
    let cancelled = false;
    let stop = (): void => undefined;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with its receiver
    const subscribe = TaskManager.prototype.subscribe;
    vi.spyOn(TaskManager.prototype, "subscribe").mockImplementation(function (
      this: TaskManager,
      listener,
    ) {
      this.create(
        "dev server",
        () =>
          new Promise<string>((resolve) => {
            stop = () => {
              cancelled = true;
              resolve("server stopped");
            };
          }),
        () => {
          stop();
        },
        { kind: "shell" },
      );
      return subscribe.call(this, listener);
    });
    vi.spyOn(Agent.prototype, "run").mockImplementation(() =>
      events(
        { type: "stream_text", text: "started" },
        { type: "loop_complete", stopReason: "end_turn" },
      ),
    );
    const wait = vi.spyOn(TaskManager.prototype, "wait");
    await runPrintMode({ prompt: "server", outputFormat: "stream-json" });
    expect(wait).not.toHaveBeenCalled();
    expect(cancelled).toBe(true);
    expect(finalResult()).toMatchObject({
      status: "completed",
      tasks: [matching({ kind: "shell", status: "cancelled" })],
    });
  });

  it("rejects invalid background wait bounds", async () => {
    const { session } = await createAgentSession({
      cwd,
      config: cfg,
      persist: false,
    });
    try {
      for (const timeoutMs of [-1, 60_001, 1.5]) {
        await expect(session.waitForBackground({ timeoutMs })).rejects.toThrow(
          "Background wait timeout",
        );
      }
    } finally {
      await session.dispose();
    }
  });
});

describe("additional SDK host boundaries", () => {
  it("waits for an active teammate round, not its idle lifetime", async () => {
    const spawn = vi.spyOn(subagents, "spawnSubagent").mockImplementation(
      (...args) =>
        new Promise((resolve) => {
          setImmediate(() => {
            expect(args[10]?.abortSignal?.aborted).toBe(false);
            resolve("teammate evidence");
          });
        }),
    );
    turns = [
      delegate({ kind: "teammate", description: "round worker" }),
      [end],
    ];
    await runPrintMode({ prompt: "delegate", outputFormat: "stream-json" });
    expect(spawn).toHaveBeenCalledOnce();
    expect(finalResult()).toMatchObject({
      status: "completed",
      teammates: [
        matching({
          status: "idle",
          lastMessage: "teammate evidence",
        }),
      ],
    });
    expect(spawn.mock.calls[0]?.[10]?.abortSignal?.aborted).toBe(true);
  });

  it("cleans all owned resources even when independent cleanup callbacks fail", async () => {
    const completed: string[] = [];
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with its receiver
    const dispose = ToolRegistry.prototype.dispose;
    vi.spyOn(ToolRegistry.prototype, "dispose").mockImplementation(function (
      this: ToolRegistry,
    ) {
      this.addCleanup(() => {
        completed.push("first");
        throw new Error("registry cleanup failed");
      });
      this.addCleanup(() => {
        completed.push("second");
      });
      return dispose.call(this);
    });
    const teamDispose = vi.spyOn(TeamManager.prototype, "dispose");
    const stopAll = vi.spyOn(TaskManager.prototype, "stopAll");
    disconnect.mockRejectedValue(new Error("connection cleanup failed"));
    await expect(
      runPrintMode({ prompt: "Task", outputFormat: "stream-json" }),
    ).rejects.toThrow("Session cleanup failed");
    expect(completed).toEqual(["first", "second"]);
    expect(teamDispose).toHaveBeenCalledOnce();
    expect(stopAll).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(JSON.stringify(finalResult())).toContain("registry cleanup failed");
    expect(JSON.stringify(finalResult())).toContain(
      "connection cleanup failed",
    );
    expect(process.exitCode).toBe(1);
  });

  it("allows local Goal status with memory enabled and a non-persistent session", async () => {
    cfg.enable_memory = true;
    await runPrintMode({
      prompt: "/goal",
      outputFormat: "stream-json",
      options: { persist: false },
    });
    expect(requests).toHaveLength(0);
    expect(finalResult()).toMatchObject({ status: "completed", num_turns: 0 });
    expect(listSessions(cwd)).toHaveLength(0);
  });

  it("resumes without recharging the previous run", async () => {
    await runPrintMode({ prompt: "first prompt", outputFormat: "stream-json" });
    const id = listSessions(cwd)[0]?.id;
    if (!id) {
      throw new Error("Missing session");
    }
    stdoutWrite.mockClear();
    turns = [[{ type: "text_delta", text: "second answer" }, end]];
    await runPrintMode({
      prompt: "second prompt",
      outputFormat: "stream-json",
      options: { sessionId: id },
    });
    expect(requests[1]).toContain("first prompt");
    expect(finalResult()).toMatchObject({
      session_id: id,
      result: "second answer",
      cost: { attempts: 1, usage: { inputTokens: 1, outputTokens: 2 } },
    });
  });
});

describe("print preauthorization", () => {
  it("fails questions even with explicit tool preauthorization", async () => {
    turns = [
      [
        {
          type: "tool_call_complete",
          toolName: "AskUserQuestion",
          toolId: "question",
          arguments: {
            questions: [
              {
                question: "Choose?",
                options: [{ label: "A" }, { label: "B" }],
                multiSelect: false,
              },
            ],
          },
        },
        { ...end, stopReason: "tool_use" },
      ],
      [end],
    ];
    await runPrintMode({ prompt: "ask", outputFormat: "stream-json" });
    expect(finalResult()).toMatchObject({
      status: "failed",
      approval_required: true,
    });
    expect(process.exitCode).toBe(1);
  });

  it("never approves a main-agent plan without an interactive host", async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with its receiver
    const execute = ExitPlanModeTool.prototype.execute;
    vi.spyOn(ExitPlanModeTool.prototype, "execute").mockImplementation(
      function (this: ExitPlanModeTool, ctx, args) {
        if (ctx.permissionChecker) {
          savePlan(ctx.permissionChecker, "Proposed work");
        }
        return execute.call(this, ctx, args);
      },
    );
    turns = [
      [
        {
          type: "tool_call_complete",
          toolName: "ExitPlanMode",
          toolId: "plan",
          arguments: {},
        },
        { ...end, stopReason: "tool_use" },
      ],
      [end],
    ];
    await runPrintMode({
      prompt: "plan",
      outputFormat: "stream-json",
      options: { permissionMode: "plan" },
    });
    expect(finalResult()).toMatchObject({
      status: "failed",
      approval_required: true,
    });
    expect(process.exitCode).toBe(1);
  });
  it("does not execute an unapproved tool under the default permission mode", async () => {
    delete cfg.permission_mode;
    turns = [
      [
        {
          type: "tool_call_complete",
          toolName: "WriteFile",
          toolId: "write",
          arguments: {
            file_path: join(cwd, "unapproved.txt"),
            content: "must not write",
          },
        },
        { ...end, stopReason: "tool_use" },
      ],
      [end],
    ];
    await runPrintMode({ prompt: "write", outputFormat: "stream-json" });
    expect(existsSync(join(cwd, "unapproved.txt"))).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(finalResult()).toMatchObject({
      status: "failed",
      approval_required: true,
    });
    expect(jsonLines()).toContainEqual(
      matching({
        type: "tool_result",
        payload: matching({ toolId: "write", isError: true }),
      }),
    );
  });

  it("passes explicit provider, model, tool and memory-only invocation choices through the SDK", async () => {
    await runPrintMode({
      prompt: "hello",
      outputFormat: "stream-json",
      options: {
        provider: "test",
        model: "override",
        tools: ["ReadFile"],
        persist: false,
        noProjectResources: true,
      },
    });
    expect(vi.mocked(clients.createClient).mock.calls[0]?.[0]).toMatchObject({
      name: "test",
      model: "override",
    });
    expect(toolNames[0]).toEqual(["ReadFile"]);
    expect(listSessions(cwd)).toHaveLength(0);
    expect(finalResult()).toMatchObject({ status: "completed" });
  });
});

it("preserves attachments when expanding the ultracode workflow prompt", async () => {
  writeFileSync(join(cwd, "context.txt"), "ATTACHMENT_CONTEXT");
  await runPrintMode({
    prompt: "/ultracode inspect context",
    outputFormat: "text",
    options: { attachments: ["context.txt"] },
  });
  expect(requests[0]).toContain("Task: inspect context");
  expect(requests[0]).toContain("ATTACHMENT_CONTEXT");
});

it("preserves stdin task text when expanding the ultracode workflow prompt", async () => {
  vi.spyOn(invocation, "loadInvocationInput").mockResolvedValue(
    "/ultracode inspect context\nSTDIN_CONTEXT",
  );
  await runPrintMode({
    prompt: "/ultracode inspect context",
    outputFormat: "text",
  });
  expect(requests[0]).toContain("Task: inspect context");
  expect(requests[0]).toContain("STDIN_CONTEXT");
});
