import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Role, TaskState } from "@a2a-js/sdk";
import type { Message, Part, SendMessageRequest } from "@a2a-js/sdk";
import {
  DefaultExecutionEventBus,
  RequestContext,
  ServerCallContext,
} from "@a2a-js/sdk/server";
import type { AgentExecutionEvent } from "@a2a-js/sdk/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { A2aRuntime, A2aRuntimeFactory } from "@/a2a/executor.js";
import { YukinoA2aExecutor } from "@/a2a/executor.js";
import type { AgentEvent } from "@/agent/events.js";
import type { PermissionRequestHandler } from "@/tools/types.js";

interface FakeRuntimeOptions {
  events?: AgentEvent[];
  onRun?: (callbacks: {
    onPermissionRequest: PermissionRequestHandler;
  }) => Promise<void>;
}

function fakeRuntime(
  cwd: string,
  options: FakeRuntimeOptions = {},
): A2aRuntime {
  return {
    sessionId: "session-12345678",
    cwd,
    async *run(_text, callbacks) {
      if (options.onRun) {
        await options.onRun(callbacks);
      }
      for (const event of options.events ?? []) {
        yield event;
      }
    },
    abort: vi.fn(),
    dispose: vi.fn(() => Promise.resolve()),
  };
}

function userMessage(parts: Part[], taskId = "", contextId = ""): Message {
  return {
    messageId: `msg-${String(Math.random())}`,
    contextId,
    taskId,
    role: Role.ROLE_USER,
    parts,
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function textParts(text: string): Part[] {
  return [
    {
      content: { $case: "text", value: text },
      metadata: undefined,
      filename: "",
      mediaType: "text/plain",
    },
  ];
}

function dataParts(data: unknown): Part[] {
  return [
    {
      content: { $case: "data", value: data },
      metadata: undefined,
      filename: "",
      mediaType: "application/json",
    },
  ];
}

interface ExecuteResult {
  events: AgentExecutionEvent[];
  bus: DefaultExecutionEventBus;
}

async function executeTurn(
  executor: YukinoA2aExecutor,
  message: Message,
  taskId: string,
  contextId: string,
): Promise<ExecuteResult> {
  const request: SendMessageRequest = {
    tenant: "",
    message,
    configuration: undefined,
    metadata: undefined,
  };
  const requestContext = new RequestContext(
    request,
    taskId,
    contextId,
    new ServerCallContext(),
  );
  const bus = new DefaultExecutionEventBus();
  const events: AgentExecutionEvent[] = [];
  bus.on("event", (event) => {
    events.push(event);
  });
  await executor.execute(requestContext, bus);
  return { events, bus };
}

function statusStates(events: AgentExecutionEvent[]): TaskState[] {
  return events.flatMap((event) =>
    event.kind === "statusUpdate"
      ? [event.data.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED]
      : [],
  );
}

function dataPayloads(events: AgentExecutionEvent[]): unknown[] {
  const payloads: unknown[] = [];
  for (const event of events) {
    if (event.kind !== "statusUpdate") {
      continue;
    }
    for (const part of event.data.status?.message?.parts ?? []) {
      if (part.content?.$case === "data") {
        payloads.push(part.content.value);
      }
    }
  }
  return payloads;
}

describe("YukinoA2aExecutor", () => {
  const cwds: string[] = [];
  function makeCwd(): string {
    const dir = mkdtempSync(join(tmpdir(), "yukino-a2a-"));
    cwds.push(dir);
    return dir;
  }

  afterEach(() => {
    while (cwds.length > 0) {
      const dir = cwds.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("runs a turn to completion and publishes the task lifecycle", async () => {
    const cwd = makeCwd();
    const runtime = fakeRuntime(cwd, {
      events: [
        { type: "stream_text", text: "hello" },
        {
          type: "tool_use",
          toolName: "Bash",
          toolId: "tool-1",
          args: { command: "ls" },
        },
        {
          type: "tool_result",
          toolName: "Bash",
          toolId: "tool-1",
          output: "files",
          isError: false,
          elapsed: 0.5,
        },
        { type: "loop_complete", stopReason: "end_turn" },
      ],
    });
    const factory: A2aRuntimeFactory = () => Promise.resolve(runtime);
    const executor = new YukinoA2aExecutor(factory, cwd);

    const { events } = await executeTurn(
      executor,
      userMessage(textParts("do the thing")),
      "task-1",
      "context-1",
    );

    expect(events[0]?.kind).toBe("task");
    expect(statusStates(events)).toEqual([
      TaskState.TASK_STATE_WORKING,
      TaskState.TASK_STATE_WORKING,
      TaskState.TASK_STATE_WORKING,
      TaskState.TASK_STATE_COMPLETED,
    ]);
    const payloads = dataPayloads(events);
    expect(payloads[0]).toMatchObject({
      yukino: "tool-call",
      toolCallId: "tool-1",
      toolName: "Bash",
    });
    expect(payloads[1]).toMatchObject({
      yukino: "tool-result",
      toolCallId: "tool-1",
      isError: false,
      output: "files",
    });
    await executor.dispose();
  });

  it("surfaces permission requests as input-required and resumes on response", async () => {
    const cwd = makeCwd();
    const decisions: string[] = [];
    const runtime = fakeRuntime(cwd, {
      events: [{ type: "loop_complete", stopReason: "end_turn" }],
      onRun: async (callbacks) => {
        const decision = await callbacks.onPermissionRequest(
          "Bash",
          { command: "rm -rf build" },
          { effect: "ask", reason: "Mode: default" },
          "tool-9",
        );
        decisions.push(decision);
      },
    });
    const factory: A2aRuntimeFactory = () => Promise.resolve(runtime);
    const executor = new YukinoA2aExecutor(factory, cwd);

    const first = await executeTurn(
      executor,
      userMessage(textParts("clean build")),
      "task-2",
      "context-2",
    );
    expect(statusStates(first.events).at(-1)).toBe(
      TaskState.TASK_STATE_INPUT_REQUIRED,
    );
    const request = dataPayloads(first.events).find(
      (payload): payload is { permissionId: string } =>
        typeof payload === "object" &&
        payload !== null &&
        "yukino" in payload &&
        payload.yukino === "permission-request",
    );
    expect(request).toBeDefined();
    expect(decisions).toEqual([]);

    const second = await executeTurn(
      executor,
      userMessage(
        dataParts({
          yukino: "permission-response",
          permissionId: request?.permissionId,
          decision: "allow",
        }),
        "task-2",
        "context-2",
      ),
      "task-2",
      "context-2",
    );
    expect(decisions).toEqual(["allow"]);
    expect(statusStates(second.events).at(-1)).toBe(
      TaskState.TASK_STATE_COMPLETED,
    );
    await executor.dispose();
  });

  it("cancels a run blocked on a permission request", async () => {
    const cwd = makeCwd();
    const decisions: string[] = [];
    const runtime = fakeRuntime(cwd, {
      events: [{ type: "loop_complete", stopReason: "end_turn" }],
      onRun: async (callbacks) => {
        const decision = await callbacks.onPermissionRequest(
          "Bash",
          {},
          { effect: "ask", reason: "ask" },
          "tool-1",
        );
        decisions.push(decision);
      },
    });
    const abort = vi.spyOn(runtime, "abort");
    const factory: A2aRuntimeFactory = () => Promise.resolve(runtime);
    const executor = new YukinoA2aExecutor(factory, cwd);

    const first = await executeTurn(
      executor,
      userMessage(textParts("go")),
      "task-3",
      "context-3",
    );
    expect(statusStates(first.events).at(-1)).toBe(
      TaskState.TASK_STATE_INPUT_REQUIRED,
    );

    const cancelBus = new DefaultExecutionEventBus();
    const cancelEvents: AgentExecutionEvent[] = [];
    cancelBus.on("event", (event) => {
      cancelEvents.push(event);
    });
    await executor.cancelTask("task-3", cancelBus);

    expect(abort).toHaveBeenCalled();
    expect(decisions).toEqual(["deny"]);
    expect(statusStates(cancelEvents).at(-1)).toBe(
      TaskState.TASK_STATE_CANCELED,
    );
    await executor.dispose();
  });

  it("withdraws an interrupted child's permission request while the parent keeps running", async () => {
    const cwd = makeCwd();
    const controller = new AbortController();
    const decisions: string[] = [];
    let release: () => void = () => undefined;
    const parentWork = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = fakeRuntime(cwd, {
      onRun: async ({ onPermissionRequest }) => {
        decisions.push(
          await onPermissionRequest(
            "Bash",
            {},
            { effect: "ask", reason: "ask" },
            "child-tool",
            controller.signal,
          ),
        );
        await parentWork;
      },
    });
    const abort = vi.spyOn(runtime, "abort");
    const executor = new YukinoA2aExecutor(() => Promise.resolve(runtime), cwd);
    try {
      const first = await executeTurn(
        executor,
        userMessage(textParts("go")),
        "task-child",
        "context-child",
      );
      const request = dataPayloads(first.events).find(
        (payload): payload is { permissionId: string } =>
          typeof payload === "object" &&
          payload !== null &&
          "permissionId" in payload &&
          typeof payload.permissionId === "string",
      );
      expect(request).toBeDefined();
      controller.abort();
      await vi.waitFor(() => {
        expect(decisions).toEqual(["deny"]);
      });
      expect(statusStates(first.events).at(-1)).toBe(
        TaskState.TASK_STATE_WORKING,
      );
      const stale = await executeTurn(
        executor,
        userMessage(
          dataParts({
            yukino: "permission-response",
            permissionId: request?.permissionId,
            decision: "allow",
          }),
          "task-child",
          "context-child",
        ),
        "task-child",
        "context-child",
      );
      expect(stale.events).toHaveLength(1);
      expect(stale.events[0]?.kind).toBe("message");
      expect(JSON.stringify(stale.events)).toContain(
        "Unknown or already resolved permission id",
      );
      expect(abort).not.toHaveBeenCalled();
    } finally {
      release();
      await executor.dispose();
    }
  });

  it("does not publish a permission request for an already interrupted child", async () => {
    const cwd = makeCwd();
    const controller = new AbortController();
    controller.abort();
    const decisions: string[] = [];
    const runtime = fakeRuntime(cwd, {
      onRun: async ({ onPermissionRequest }) => {
        decisions.push(
          await onPermissionRequest(
            "Bash",
            {},
            { effect: "ask", reason: "ask" },
            "child-tool",
            controller.signal,
          ),
        );
      },
    });
    const executor = new YukinoA2aExecutor(() => Promise.resolve(runtime), cwd);
    try {
      const { events } = await executeTurn(
        executor,
        userMessage(textParts("go")),
        "task-child",
        "context-child",
      );
      expect(statusStates(events)).not.toContain(
        TaskState.TASK_STATE_INPUT_REQUIRED,
      );
      expect(statusStates(events).at(-1)).toBe(TaskState.TASK_STATE_COMPLETED);
      expect(decisions).toEqual(["deny"]);
    } finally {
      await executor.dispose();
    }
  });

  it("keeps another child's approval pending when one child is interrupted", async () => {
    const cwd = makeCwd();
    const controller = new AbortController();
    const otherController = new AbortController();
    const removeListener = vi.spyOn(
      otherController.signal,
      "removeEventListener",
    );
    const decisions: string[] = [];
    const runtime = fakeRuntime(cwd, {
      onRun: async ({ onPermissionRequest }) => {
        decisions.push(
          ...(await Promise.all([
            onPermissionRequest(
              "Bash",
              {},
              { effect: "ask", reason: "ask" },
              "stopped-child",
              controller.signal,
            ),
            onPermissionRequest(
              "Bash",
              {},
              { effect: "ask", reason: "ask" },
              "other-child",
              otherController.signal,
            ),
          ])),
        );
      },
    });
    const executor = new YukinoA2aExecutor(() => Promise.resolve(runtime), cwd);
    const abort = vi.spyOn(runtime, "abort");
    try {
      const first = await executeTurn(
        executor,
        userMessage(textParts("go")),
        "task-children",
        "context-children",
      );
      controller.abort();
      const pending = dataPayloads(first.events).at(-1);
      if (
        typeof pending !== "object" ||
        pending === null ||
        !("permissionId" in pending)
      ) {
        throw new Error("Expected the remaining permission request");
      }
      expect(pending).toMatchObject({ toolCallId: "other-child" });
      const lastStatus = first.events.at(-1);
      expect(
        lastStatus?.kind === "statusUpdate"
          ? lastStatus.data.status?.message?.parts
          : [],
      ).toHaveLength(1);
      expect(statusStates(first.events).at(-1)).toBe(
        TaskState.TASK_STATE_INPUT_REQUIRED,
      );
      const second = await executeTurn(
        executor,
        userMessage(
          dataParts({
            yukino: "permission-response",
            permissionId: pending.permissionId,
            decision: "allow",
          }),
          "task-children",
          "context-children",
        ),
        "task-children",
        "context-children",
      );
      expect(decisions).toEqual(["deny", "allow"]);
      expect(statusStates(second.events).at(-1)).toBe(
        TaskState.TASK_STATE_COMPLETED,
      );
      expect(removeListener).toHaveBeenCalledWith(
        "abort",
        expect.any(Function),
      );
      expect(abort).not.toHaveBeenCalled();
    } finally {
      await executor.dispose();
    }
  });

  it("fails a task when the message carries no text", async () => {
    const cwd = makeCwd();
    const runtime = fakeRuntime(cwd);
    const executor = new YukinoA2aExecutor(() => Promise.resolve(runtime), cwd);

    const { events } = await executeTurn(
      executor,
      userMessage([]),
      "task-4",
      "context-4",
    );
    expect(statusStates(events).at(-1)).toBe(TaskState.TASK_STATE_FAILED);
    await executor.dispose();
  });

  it("fails the task when the runtime cannot be created", async () => {
    const cwd = makeCwd();
    const executor = new YukinoA2aExecutor(
      () => Promise.reject(new Error("No provider configured.")),
      cwd,
    );

    const { events } = await executeTurn(
      executor,
      userMessage(textParts("hi")),
      "task-5",
      "context-5",
    );
    expect(statusStates(events).at(-1)).toBe(TaskState.TASK_STATE_FAILED);
    await executor.dispose();
  });

  it("rejects concurrent turns while the same context is initializing", async () => {
    const cwd = makeCwd();
    let releaseRun = (): void => undefined;
    const running = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const onRun = vi.fn(() => running);
    const runtime = fakeRuntime(cwd, { onRun });
    let initialize = (_runtime: A2aRuntime): void => undefined;
    const initializing = new Promise<A2aRuntime>((resolve) => {
      initialize = resolve;
    });
    const factory = vi.fn(() => initializing);
    const executor = new YukinoA2aExecutor(factory, cwd);
    const first = executeTurn(
      executor,
      userMessage(textParts("first")),
      "first-task",
      "shared-context",
    );
    const second = executeTurn(
      executor,
      userMessage(textParts("second")),
      "second-task",
      "shared-context",
    );

    try {
      initialize(runtime);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const startedRuns = onRun.mock.calls.length;
      releaseRun();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(factory).toHaveBeenCalledOnce();
      expect(startedRuns).toBe(1);
      expect(statusStates(firstResult.events).at(-1)).toBe(
        TaskState.TASK_STATE_COMPLETED,
      );
      const rejection = secondResult.events.flatMap((event) =>
        event.kind === "message"
          ? event.data.parts.flatMap((part) =>
              part.content?.$case === "text" ? [part.content.value] : [],
            )
          : [],
      );
      expect(rejection.join("\n")).toContain("busy with task first-task");
    } finally {
      releaseRun();
      await Promise.allSettled([first, second]);
      await executor.dispose();
    }
  });

  it("does not start a turn after disposal during runtime initialization", async () => {
    const cwd = makeCwd();
    const onRun = vi.fn(() => Promise.resolve());
    const runtime = fakeRuntime(cwd, { onRun });
    const dispose = vi.spyOn(runtime, "dispose");
    let initialize = (_runtime: A2aRuntime): void => undefined;
    const initializing = new Promise<A2aRuntime>((resolve) => {
      initialize = resolve;
    });
    const executor = new YukinoA2aExecutor(() => initializing, cwd);
    const turn = executeTurn(
      executor,
      userMessage(textParts("first")),
      "first-task",
      "shared-context",
    );
    const closing = executor.dispose();
    initialize(runtime);
    const [result] = await Promise.all([turn, closing]);
    expect(onRun).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(statusStates(result.events).at(-1)).toBe(
      TaskState.TASK_STATE_FAILED,
    );
  });

  it("does not create a runtime for an invalid message", async () => {
    const cwd = makeCwd();
    const factory = vi.fn(() => Promise.resolve(fakeRuntime(cwd)));
    const executor = new YukinoA2aExecutor(factory, cwd);

    const { events } = await executeTurn(
      executor,
      userMessage([]),
      "task-6",
      "context-6",
    );
    expect(statusStates(events).at(-1)).toBe(TaskState.TASK_STATE_FAILED);
    // An empty message must not spin up an agent runtime.
    expect(factory).not.toHaveBeenCalled();
    await executor.dispose();
  });

  it("evicts an idle runtime and recreates it with the saved session id", async () => {
    const cwd = makeCwd();
    const createdSessionIds: (string | undefined)[] = [];
    const disposed: string[] = [];
    let counter = 0;
    const factory: A2aRuntimeFactory = (_cwd, sessionId) => {
      createdSessionIds.push(sessionId);
      const id = sessionId ?? `session-${String(++counter)}`;
      const runtime = fakeRuntime(cwd, {
        events: [{ type: "loop_complete", stopReason: "end_turn" }],
      });
      return Promise.resolve({
        ...runtime,
        sessionId: id,
        dispose: () => {
          disposed.push(id);
          return Promise.resolve();
        },
      });
    };
    const executor = new YukinoA2aExecutor(factory, cwd, 20);

    await executeTurn(
      executor,
      userMessage(textParts("hello")),
      "task-7",
      "context-7",
    );
    expect(createdSessionIds).toEqual([undefined]);

    // Let the idle timer fire and dispose the runtime.
    await new Promise((resolve) => {
      setTimeout(resolve, 60);
    });
    expect(disposed).toEqual(["session-1"]);

    // A follow-up on the same context recreates the runtime, passing the saved
    // session id so the factory can restore the transcript.
    const second = await executeTurn(
      executor,
      userMessage(textParts("again")),
      "task-8",
      "context-7",
    );
    expect(createdSessionIds).toEqual([undefined, "session-1"]);
    expect(statusStates(second.events).at(-1)).toBe(
      TaskState.TASK_STATE_COMPLETED,
    );
    await executor.dispose();
  });
});
