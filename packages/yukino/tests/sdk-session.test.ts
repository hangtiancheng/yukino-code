import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { CacheWarmingScheduler } from "@/cache/warming.js";
import { withExecutionContext } from "@/cost/context.js";
import { createCostLedger } from "@/cost/ledger.js";
import { HookEngine } from "@/hooks/index.js";
import { RateLimitError } from "@/llm/errors.js";
import { MCPClient } from "@/mcp/client.js";
import { MCPServerConfigSchema } from "@/mcp/config.js";
import { MCPManager } from "@/mcp/manager.js";
import { PermissionChecker } from "@/permissions/index.js";
import { RpcServer } from "@/rpc/server.js";
import {
  createAgentSession,
  SessionBusyError,
  SessionManager,
  ToolRegistry,
  type AgentSession,
  type LLMClient,
  type Message,
  type SessionEvent,
  type StreamEvent,
  type Tool,
} from "@/sdk/index.js";
import { getSessionFilePath } from "@/session/records.js";
import { getYukinoDir, sessionPath } from "@/storage/index.js";

const usage = {
  inputTokens: 2,
  outputTokens: 1,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};
const end: Extract<StreamEvent, { type: "stream_end" }> = {
  type: "stream_end",
  stopReason: "end_turn",
  usage,
};
const sessions: AgentSession[] = [];
afterEach(async () => {
  try {
    await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  } finally {
    vi.restoreAllMocks();
  }
});
function cwd(): string {
  const directory = join(dirname(getYukinoDir()), "project");
  mkdirSync(directory, { recursive: true });
  return directory;
}
function deferred() {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class MockClient implements LLMClient {
  calls: Message[][] = [];
  setSystemPrompt = vi.fn();
  dispose = vi.fn();
  constructor(
    private scripts: (
      StreamEvent[] | ((signal?: AbortSignal) => Promise<StreamEvent[]>)
    )[] = [],
  ) {}
  async *stream(
    conversation: { getMessages(): Message[] },
    _tools: unknown[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const index = this.calls.length;
    this.calls.push(structuredClone(conversation.getMessages()));
    const script = this.scripts[index] ?? [
      { type: "text_delta", text: `answer ${index + 1}` },
      end,
    ];
    const events = typeof script === "function" ? await script(signal) : script;
    for (const event of events) {
      await Promise.resolve();
      yield event;
    }
  }
}
async function make(
  client = new MockClient(),
  extra: Parameters<typeof createAgentSession>[0] = {},
) {
  const result = await createAgentSession({
    cwd: cwd(),
    client,
    persist: false,
    tools: [],
    ...extra,
  });
  sessions.push(result.session);
  return { ...result, client };
}
function echo(category: Tool["category"] = "read") {
  return {
    name: "Echo",
    description: "echo",
    category,
    schema: (): ReturnType<Tool["schema"]> => ({
      name: "Echo",
      description: "echo",
      input_schema: { type: "object", properties: {} },
    }),
    execute: vi.fn(() =>
      Promise.resolve({ output: "echo result", isError: false }),
    ),
    dispose: vi.fn(() => Promise.resolve()),
  };
}
const mcpFixture = `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
if (process.env.MARKER) writeFileSync(process.env.MARKER, 'spawned');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (!('id' in message)) return;
  let result = {};
  if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'sdk-fixture', version: '1' } };
  if (message.method === 'tools/list') result = { tools: [{ name: 'read', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } }] };
  if (message.method === 'resources/list') result = message.params?.cursor === 'next' ? { resources: [{ name: 'three', uri: 'docs://three' }] } : { resources: [{ name: 'one', uri: 'docs://one' }, { name: 'two', uri: 'docs://two' }], nextCursor: 'next' };
  if (message.method === 'resources/templates/list') result = { resourceTemplates: [{ name: 'doc', uriTemplate: 'docs://{id}' }, { name: 'blob', uriTemplate: 'blob://{id}' }] };
  if (message.method === 'resources/read') result = { contents: [{ uri: message.params.uri, mimeType: 'application/octet-stream', blob: Buffer.alloc(20 * 1024, 1).toString('base64') }] };
  if (message.method === 'tools/call') result = { content: [{ type: 'text', text: 'ok' }] };
  send({ jsonrpc: '2.0', id: message.id, result });
});
`;
function mcpConfig(name: string, marker?: string) {
  return {
    name,
    command: process.execPath,
    args: ["--input-type=module", "-e", mcpFixture],
    env: marker ? { MARKER: marker } : undefined,
    exposure: "direct" as const,
  };
}
async function mcpRPC(
  session: AgentSession,
  command: string,
  args: Record<string, unknown>,
) {
  const output = new PassThrough();
  const schema = z.object({
    type: z.literal("response"),
    success: z.boolean(),
    result: z.unknown().optional(),
  });
  const response = new Promise<z.infer<typeof schema>>((resolve) => {
    output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().trim().split("\n")) {
        const raw: unknown = JSON.parse(line);
        const message = schema.safeParse(raw);
        if (message.success) {
          resolve(message.data);
        }
      }
    });
  });
  const server = new RpcServer(
    {
      sessionId: () => session.sessionId,
      subscribe: () => () => undefined,
      abort: () => session.abort("all"),
      dispose: () => Promise.resolve(),
      handlers: {
        mcp_register: (input) =>
          session.registerMCPServer(MCPServerConfigSchema.parse(input.config)),
        mcp_resources: (input) =>
          session.listMCPResources(String(input.server), {
            cursor: typeof input.cursor === "string" ? input.cursor : undefined,
            limit: typeof input.limit === "number" ? input.limit : undefined,
          }),
        mcp_templates: (input) =>
          session.listMCPResources(String(input.server), {
            templates: true,
            cursor: typeof input.cursor === "string" ? input.cursor : undefined,
            limit: typeof input.limit === "number" ? input.limit : undefined,
          }),
        mcp_connect: (input) => session.connectMCPServer(String(input.server)),
        mcp_disconnect: (input) =>
          session.disconnectMCPServer(String(input.server)),
      },
    },
    output,
  );
  server.receive(
    JSON.stringify({
      version: 1,
      type: "request",
      commandId: "mcp-test",
      command,
      args,
    }),
  );
  const result = await response;
  await server.stop();
  return result;
}
function toolCall(): StreamEvent[] {
  return [
    {
      type: "tool_call_complete",
      toolName: "Echo",
      toolId: "echo-call",
      arguments: {},
    },
    { ...end, stopReason: "tool_use" },
  ];
}

describe("terminal-independent SDK", () => {
  it("serializes background waits with foreground work and cancels them on session replacement", async () => {
    const { session, client } = await make();
    const gate = deferred();
    const runtime = session.runtime;
    runtime.backgroundTaskManager.create(
      "pending",
      async () => {
        await gate.promise;
        return "old session result";
      },
      () => {
        gate.resolve();
      },
    );
    const waiting = session.waitForBackground({ timeoutMs: 10_000 });
    const cancelled = waiting.then(
      () => false,
      () => true,
    );
    try {
      expect(session.isBusy).toBe(true);
      await expect(session.prompt("must not race")).rejects.toBeInstanceOf(
        SessionBusyError,
      );
      await session.newSession({ persist: false });
      expect(await cancelled).toBe(true);
      expect(
        session
          .getMessages()
          .some(
            (message) =>
              typeof message.content === "string" &&
              message.content.includes("old session result"),
          ),
      ).toBe(false);
      expect(client.calls).toHaveLength(0);
    } finally {
      gate.resolve();
      await cancelled;
    }
  });

  it("cleans up the session even if aborting its work fails", async () => {
    const { session } = await make();
    const runtime = session.runtime;
    const dispose = vi.spyOn(runtime, "dispose");
    const events: SessionEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });
    vi.spyOn(session, "abort").mockRejectedValueOnce(new Error("abort failed"));
    try {
      await expect(session.dispose()).rejects.toThrow(/cleanup failed/i);
      expect(dispose).toHaveBeenCalledOnce();
      expect(events.some((event) => event.type === "disposed")).toBe(true);
    } finally {
      sessions.splice(sessions.indexOf(session), 1);
      await runtime.dispose();
    }
  });

  it("continues a tracked session without duplicating its final checkpoint", async () => {
    const { session, client } = await make(new MockClient(), {
      persist: true,
      trackFileChanges: true,
    });
    expect(await session.prompt("task")).toMatchObject({ status: "completed" });
    expect(await session.continueRun()).toMatchObject({ status: "completed" });
    expect(client.calls).toHaveLength(2);
    const checkpoints = session.runtime.fileHistory.getSnapshots();
    expect(new Set(checkpoints.map((entry) => entry.entryId)).size).toBe(
      checkpoints.length,
    );
  });

  it("runs consecutive prompts on the real Agent and isolates sync/async listener errors", async () => {
    const { session, client, sessionManager } = await make();
    const handlersBefore = process.listenerCount("SIGINT");
    const events: SessionEvent[] = [];
    const unsubscribe = session.subscribe((event) => {
      events.push(event);
    });
    session.subscribe(() => {
      throw new Error("display failure");
    });
    session.subscribe(() => Promise.reject(new Error("async display failure")));
    const first = await session.prompt("first");
    const second = await session.prompt("second");
    const failure = events.find((event) => event.type === "error");
    if (failure?.type === "error") {
      throw failure.payload.error;
    }
    expect(first).toMatchObject({
      status: "completed",
      text: "answer 1",
      sessionId: sessionManager.id,
      usage,
    });
    expect(second.text).toBe("answer 2");
    expect(client.calls[1].some((message) => message.content === "first")).toBe(
      true,
    );
    expect(
      session.getEntries().filter((entry) => !entry.message.type),
    ).toHaveLength(4);
    expect(events.map((event) => event.sequence)).toEqual(
      [...events].map((_event, index) => index + 2),
    );
    expect(events.some((event) => event.type === "run_settled")).toBe(true);
    expect(session.getStats().attempts).toBe(2);
    expect(existsSync(getSessionFilePath(session.cwd, session.sessionId))).toBe(
      false,
    );
    expect(process.listenerCount("SIGINT")).toBe(handlersBefore);
    const count = events.length;
    unsubscribe();
    await session.prompt("third");
    expect(events).toHaveLength(count);
  });

  it("keeps queue modes and retry state live, detached and reset between runs", async () => {
    const { session } = await make(
      new MockClient([
        () => Promise.reject(new RateLimitError("local retry", "0.001")),
        [{ type: "text_delta", text: "recovered" }, end],
      ]),
    );
    expect(session.getQueueModes()).toEqual({
      steering: "all",
      followUp: "one-at-a-time",
    });
    const modes = session.getQueueModes();
    modes.steering = "one-at-a-time";
    expect(session.getQueueModes().steering).toBe("all");
    session.setQueueMode("steer", "one-at-a-time");
    session.setQueueMode("followUp", "all");
    expect(session.getQueueModes()).toEqual({
      steering: "one-at-a-time",
      followUp: "all",
    });
    const retrySnapshots: ReturnType<AgentSession["getRetryState"]>[] = [];
    const clearedSnapshots: ReturnType<AgentSession["getRetryState"]>[] = [];
    session.subscribe((event) => {
      if (event.type === "retry") {
        const retry = session.getRetryState();
        if (retry) {
          retry.reason = "mutated";
        }
        retrySnapshots.push(session.getRetryState());
      } else if (
        event.type === "stream_text" ||
        event.type === "run_started" ||
        event.type === "run_settled"
      ) {
        clearedSnapshots.push(session.getRetryState());
      }
    });
    await session.prompt("retry fixture");
    expect(retrySnapshots).toEqual([{ reason: "rate limited", delay: 1 }]);
    expect(clearedSnapshots.length).toBeGreaterThan(0);
    expect(clearedSnapshots.every((state) => state === null)).toBe(true);
    expect(session.getRetryState()).toBeNull();
    await session.prompt("next run");
    expect(session.getRetryState()).toBeNull();
  });

  it("rejects busy delivery, preserves FIFO follow-ups, and settles after the foreground queue", async () => {
    const gate = deferred();
    const started = deferred();
    const client = new MockClient([
      async () => {
        started.resolve();
        await gate.promise;
        return [{ type: "text_delta", text: "first" }, end];
      },
    ]);
    const { session } = await make(client);
    const first = session.prompt("first");
    await started.promise;
    await expect(session.prompt("implicit")).rejects.toBeInstanceOf(
      SessionBusyError,
    );
    const second = session.prompt("second", { delivery: "followUp" });
    const third = session.followUp("third").completion;
    expect(session.getQueue().map((entry) => entry.text)).toEqual([
      "second",
      "third",
    ]);
    let settled = false;
    session.subscribe((event) => {
      if (event.type === "run_settled") {
        settled = true;
        expect(session.getQueue()).toEqual([]);
      }
    });
    expect(settled).toBe(false);
    gate.resolve();
    await Promise.all([first, second, third, session.waitForIdle()]);
    expect(client.calls).toHaveLength(3);
    expect(
      client.calls.map(
        (messages) =>
          messages.filter((message) => message.role === "user").at(-1)?.content,
      ),
    ).toEqual(["first", "second", "third"]);
    expect(settled).toBe(true);
  });

  it("batches follow-up mode all without merging or losing independent user inputs", async () => {
    const gate = deferred();
    const started = deferred();
    const { session, client } = await make(
      new MockClient([
        async () => {
          started.resolve();
          await gate.promise;
          return [end];
        },
      ]),
      { followUpMode: "all" },
    );
    const first = session.prompt("first");
    await started.promise;
    const second = session.followUp("second");
    const third = session.followUp("third");
    gate.resolve();
    const [, b, c] = await Promise.all([
      first,
      second.completion,
      third.completion,
    ]);
    expect(client.calls).toHaveLength(2);
    expect(b.runId).toBe(c.runId);
    expect(
      client.calls[1]
        .filter(
          (message) =>
            message.content === "second" || message.content === "third",
        )
        .map((message) => message.content),
    ).toEqual(["second", "third"]);
  });

  it("delivers and persists image-only steering at a turn boundary without mutating queued attachments", async () => {
    const gate = deferred();
    const started = deferred();
    const { session, client } = await make(
      new MockClient([
        async () => {
          started.resolve();
          await gate.promise;
          return [end];
        },
      ]),
      { persist: true },
    );
    const first = session.prompt("first");
    await started.promise;
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
    };
    const expected = structuredClone(image);
    const receipt = session.steer({ text: "", attachments: [image] });
    image.source.data = "changed";
    const queued = session.getQueue();
    expect(
      queued.find((entry) => entry.id === receipt.id)?.attachments,
    ).toEqual([expected]);
    gate.resolve();
    const [initial, result] = await Promise.all([first, receipt.completion]);
    expect(result.status).toBe("completed");
    expect(result.runId).toBe(initial.runId);
    const message = client.calls[1].find(
      (item) => item.userInput?.id === receipt.id,
    );
    expect(message?.content).toEqual([{ type: "text", text: "" }, expected]);
    const restored = SessionManager.open(
      session.cwd,
      session.sessionId,
    ).getMessages();
    expect(
      restored.find((item) => item.userInput?.id === receipt.id)?.content,
    ).toEqual(message?.content);
  });

  it("cancels submitted image steering without sending its attachment to the model", async () => {
    const gate = deferred();
    const started = deferred();
    const { session, client } = await make(
      new MockClient([
        async () => {
          started.resolve();
          await gate.promise;
          return [end];
        },
      ]),
    );
    const first = session.prompt("first");
    await started.promise;
    const controller = new AbortController();
    const receipt = session.steer(
      {
        text: "cancel screenshot",
        attachments: [
          {
            type: "image",
            source: { type: "url", url: "https://example.invalid/image.png" },
          },
        ],
      },
      { signal: controller.signal },
    );
    controller.abort();
    expect((await receipt.completion).status).toBe("aborted");
    expect(session.getQueue()).toEqual([]);
    gate.resolve();
    await first;
    expect(client.calls).toHaveLength(1);
    expect(
      session.getMessages().some((item) => item.userInput?.id === receipt.id),
    ).toBe(false);
  });

  it("delivers steering one-at-a-time across Agent turn boundaries", async () => {
    const gate = deferred();
    const started = deferred();
    const { session, client } = await make(
      new MockClient([
        async () => {
          started.resolve();
          await gate.promise;
          return [end];
        },
      ]),
      { steeringMode: "one-at-a-time" },
    );
    const first = session.prompt("first");
    await started.promise;
    const second = session.steer("second");
    const third = session.steer("third");
    gate.resolve();
    const results = await Promise.all([
      first,
      second.completion,
      third.completion,
    ]);
    expect(new Set(results.map((result) => result.runId)).size).toBe(1);
    expect(client.calls).toHaveLength(3);
    expect(client.calls[1].some((message) => message.content === "third")).toBe(
      false,
    );
    expect(client.calls[2].some((message) => message.content === "third")).toBe(
      true,
    );
  });

  it("cancels queued input separately from foreground execution", async () => {
    const gate = deferred();
    const started = deferred();
    const { session, client } = await make(
      new MockClient([
        async () => {
          started.resolve();
          await gate.promise;
          return [end];
        },
      ]),
    );
    const first = session.prompt("first");
    await started.promise;
    const queued = session.followUp("discard");
    expect(session.clearQueue()).toHaveLength(1);
    expect(await queued.completion).toMatchObject({
      status: "aborted",
      stopReason: "cancelled",
    });
    gate.resolve();
    expect(await first).toMatchObject({ status: "completed" });
    expect(client.calls).toHaveLength(1);
  });

  it.each(["foreground", "all", "signal"] as const)(
    "cancels from run_started via %s before provider execution and settles the receipt once",
    async (scope) => {
      let script = toolCall();
      const tool = echo();
      const { session, client } = await make(
        new MockClient([() => Promise.resolve(script)]),
        { tools: [tool] },
      );
      const controller = new AbortController();
      const events: SessionEvent[] = [];
      let cancellation = Promise.resolve();
      session.subscribe((event) => {
        events.push(event);
        if (
          event.type === "run_started" &&
          event.payload.input.text === "cancel before start"
        ) {
          if (scope === "signal") {
            controller.abort();
          } else {
            cancellation = session.abort(scope);
          }
        }
      });
      const receipt = session.followUp("cancel before start", {
        signal: controller.signal,
      });
      const result = await receipt.completion;
      await cancellation;
      expect(result).toMatchObject({
        status: "aborted",
        stopReason: "interrupted",
        text: "",
        messages: [],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        cost: { attempts: 0 },
      });
      expect(result.runId).not.toBe("");
      expect(client.calls).toEqual([]);
      expect(tool.execute).not.toHaveBeenCalled();
      expect(session.getStats().attempts).toBe(0);
      expect(session.getCostEntries()).toEqual([]);
      expect(events.filter((event) => event.type === "run_settled")).toEqual([
        expect.objectContaining({ runId: result.runId, payload: result }),
      ]);
      script = [{ type: "text_delta", text: "next answer" }, end];
      expect(await session.prompt("next")).toMatchObject({
        status: "completed",
        text: "next answer",
        cost: { attempts: 1 },
      });
      expect(client.calls).toHaveLength(1);
      expect(tool.execute).not.toHaveBeenCalled();
      expect(session.getStats().attempts).toBe(1);
      expect(
        events.filter(
          (event) =>
            event.type === "run_settled" && event.payload.status === "aborted",
        ),
      ).toHaveLength(1);
    },
  );

  it.each(["foreground", "signal"] as const)(
    "cancels via %s during warming preparation and continues queued follow-ups",
    async (scope) => {
      const started = deferred();
      const gate = deferred();
      const preparation = vi
        .spyOn(CacheWarmingScheduler.prototype, "setForegroundActive")
        .mockImplementationOnce(async () => {
          started.resolve();
          await gate.promise;
        });
      const tool = echo();
      const { session, client } = await make(new MockClient(), {
        tools: [tool],
      });
      const controller = new AbortController();
      const events: SessionEvent[] = [];
      session.subscribe((event) => {
        events.push(event);
      });
      const first = session.followUp("cancel during warming", {
        signal: controller.signal,
      });
      await started.promise;
      expect(preparation).toHaveBeenNthCalledWith(1, true);
      const next = session.followUp("queued next");
      try {
        if (scope === "signal") {
          controller.abort();
        } else {
          await session.abort(scope);
        }
        expect(client.calls).toEqual([]);
        expect(session.getStats().attempts).toBe(0);
      } finally {
        gate.resolve();
      }
      const [aborted, completed] = await Promise.all([
        first.completion,
        next.completion,
      ]);
      expect(aborted).toMatchObject({
        status: "aborted",
        stopReason: "interrupted",
        text: "",
        messages: [],
        cost: { attempts: 0 },
      });
      expect(completed).toMatchObject({
        status: "completed",
        text: "answer 1",
        cost: { attempts: 1 },
      });
      expect(completed.runId).not.toBe(aborted.runId);
      expect(client.calls).toHaveLength(1);
      expect(
        client.calls[0]
          .filter((message) => message.userInput)
          .map((message) => message.content),
      ).toEqual(["queued next"]);
      expect(tool.execute).not.toHaveBeenCalled();
      expect(session.getCostEntries({ runId: aborted.runId })).toEqual([]);
      expect(session.getStats().attempts).toBe(1);
      expect(session.getQueue()).toEqual([]);
      expect(
        events.filter(
          (event) =>
            event.type === "run_settled" && event.runId === aborted.runId,
        ),
      ).toEqual([
        expect.objectContaining({
          payload: aborted,
        }),
      ]);
      expect(await session.prompt("after queue")).toMatchObject({
        status: "completed",
        text: "answer 2",
      });
      expect(client.calls).toHaveLength(2);
    },
  );

  it("cancels the active runtime before waiting for warming and does not cancel the next batch", async () => {
    const started = deferred();
    const nextStarted = deferred();
    const nextGate = deferred();
    let runtimeSignal: AbortSignal | undefined;
    let nextSignal: AbortSignal | undefined;
    const { session, client } = await make(
      new MockClient([
        (signal) =>
          new Promise((resolve) => {
            runtimeSignal = signal;
            started.resolve();
            signal?.addEventListener(
              "abort",
              () => {
                resolve([end]);
              },
              { once: true },
            );
          }),
        async (signal) => {
          nextSignal = signal;
          nextStarted.resolve();
          await nextGate.promise;
          return [{ type: "text_delta", text: "answer 2" }, end];
        },
      ]),
    );
    const first = session.followUp("running");
    await started.promise;
    const next = session.followUp("queued next");
    const warming = deferred();
    vi.spyOn(CacheWarmingScheduler.prototype, "cancel").mockImplementationOnce(
      () => warming.promise,
    );
    const cancellation = session.abort("foreground");
    try {
      expect(runtimeSignal?.aborted).toBe(true);
      await nextStarted.promise;
      expect(nextSignal?.aborted).toBe(false);
      warming.resolve();
      await cancellation;
      expect(nextSignal?.aborted).toBe(false);
      nextGate.resolve();
      const [aborted, completed] = await Promise.all([
        first.completion,
        next.completion,
      ]);
      expect(aborted).toMatchObject({
        status: "aborted",
        stopReason: "interrupted",
        cost: { attempts: 1 },
      });
      expect(completed).toMatchObject({
        status: "completed",
        text: "answer 2",
        cost: { attempts: 1 },
      });
      expect(client.calls).toHaveLength(2);
    } finally {
      warming.resolve();
      nextGate.resolve();
      await cancellation;
    }
  });

  it("denies ask without a permission callback and permits explicitly approved requests", async () => {
    const denied = echo("write");
    const { session } = await make(new MockClient([toolCall()]), {
      tools: [denied],
    });
    await session.prompt("write");
    expect(denied.execute).not.toHaveBeenCalled();
    const allowed = echo("write");
    const approve = vi.fn(() => Promise.resolve<"allow">("allow"));
    const approved = await make(new MockClient([toolCall()]), {
      tools: [allowed],
      onPermissionRequest: approve,
    });
    await approved.session.prompt("write");
    expect(approve).toHaveBeenCalledOnce();
    expect(allowed.execute).toHaveBeenCalledOnce();
  });

  it("does not destroy borrowed client/registry/tools on idempotent disposal", async () => {
    const registry = new ToolRegistry();
    const tool = echo();
    registry.register(tool);
    const { session, client } = await make(new MockClient([toolCall()]), {
      registry,
      tools: ["Echo"],
    });
    await session.prompt("echo");
    expect(tool.execute).toHaveBeenCalledOnce();
    const first = session.dispose();
    expect(session.dispose()).toBe(first);
    await first;
    expect(tool.dispose).not.toHaveBeenCalled();
    expect(client.dispose).not.toHaveBeenCalled();
    expect(registry.get("Echo")).toBe(tool);
    expect(existsSync(sessionPath(session.sessionId))).toBe(false);
    await registry.dispose();
    expect(tool.dispose).toHaveBeenCalledOnce();
  });

  it("switches the stable facade, preserves subscriptions, branches, labels and export", async () => {
    const { session } = await make();
    const changes: SessionEvent[] = [];
    session.subscribe((event) => {
      if (event.type === "session_changed") {
        changes.push(event);
      }
    });
    await session.prompt("root");
    const originalId = session.sessionId;
    const firstReply = session
      .getEntries()
      .find((entry) => entry.message.content === "answer 1");
    if (!firstReply) {
      throw new Error("Missing real Agent reply");
    }
    await session.prompt("old branch");
    const costsBeforeNavigation = session.getStats().attempts;
    await session.navigate(firstReply.entryId);
    expect(session.getStats().attempts).toBe(costsBeforeNavigation);
    await session.prompt("new branch");
    expect(
      session
        .getEntries()
        .some((entry) => entry.message.content === "old branch"),
    ).toBe(true);
    expect(
      session.getMessages().some((message) => message.content === "old branch"),
    ).toBe(false);
    session.setName("work");
    session.setMetadata({ tags: ["sdk"] });
    session.setLabel(firstReply.entryId, "checkpoint");
    const root = session.getTree()[0];
    expect(root.entry.message.type).toBe("session_runtime_state");
    expect(
      root.children[0].children.find(
        (node) => node.entry.entryId === firstReply.entryId,
      )?.label,
    ).toBe("checkpoint");
    const exported = session.export({ scope: "tree", format: "jsonl" });
    expect(exported).toContain("old branch");
    expect(session.export({ scope: "tree", format: "html" })).toContain(
      "<html",
    );
    await session.clone();
    expect(session.sessionId).not.toBe(originalId);
    expect(changes).toHaveLength(2);
    expect(session.getMetadata()).toMatchObject({
      name: "work",
      tags: ["sdk"],
    });
  });

  it.each(["fork", "clone"] as const)(
    "%s preserves unbilled root/workflow ancestry and historical attempts without recharging",
    async (operation) => {
      const manager = SessionManager.create(cwd(), { persist: false });
      const userEntryId = manager.append({
        role: "user",
        content: "historical input",
      });
      const ledger = createCostLedger({ sessionId: manager.id });
      const root = {
        sessionId: manager.id,
        runId: "unbilled-root",
        agentId: "main",
        purpose: "main" as const,
        ledger,
      };
      const historicalProvider = {
        name: "historical",
        model: "historical-model",
        protocol: "anthropic" as const,
        base_url: "https://historical.invalid",
        price: {
          currency: "USD",
          input: 10,
          output: 2,
          source: "historical-price",
          effective_at: "2025-01-01T00:00:00Z",
        },
      };
      withExecutionContext(root, () => {
        withExecutionContext(
          {
            ...root,
            runId: "unbilled-workflow",
            parentRunId: root.runId,
            purpose: "workflow",
          },
          () => {
            const attempt = ledger.beginAttempt(
              {
                ...root,
                runId: "paid-child",
                parentRunId: "unbilled-workflow",
                purpose: "subagent",
              },
              historicalProvider,
            );
            attempt.snapshot(usage);
            attempt.finish("completed", true);
          },
        );
      });
      const history = ledger.getEntries();
      const relations = ledger.getRuns();
      const { session, client } = await make(new MockClient(), {
        sessionManager: manager,
        ledger,
      });
      if (operation === "fork") {
        await session.fork(userEntryId);
      } else {
        await session.clone();
      }
      const copiedManager = session.sessionManager;
      expect(session.sessionId).not.toBe(manager.id);
      expect(client.calls).toEqual([]);
      expect(session.getCostEntries()).toEqual(history);
      expect(session.getStats({ sessionId: session.sessionId }).attempts).toBe(
        0,
      );
      expect(
        session.getStats({
          sessionId: manager.id,
          runId: root.runId,
          includeDescendants: true,
        }).attempts,
      ).toBe(1);
      expect(
        session.getStats({
          sessionId: manager.id,
          runId: "unbilled-workflow",
          includeDescendants: true,
        }).attempts,
      ).toBe(1);
      expect(session.getCostEntries({ runId: root.runId })).toEqual([]);
      expect(session.getStatus().history).toEqual([
        { sessionId: manager.id, cost: ledger.summary() },
      ]);
      await session.switchSession(manager);
      expect(ledger.getRuns()).toEqual(relations);
      await session.switchSession(copiedManager);
      expect(session.getCostEntries()).toEqual(history);
      expect(
        session.getStats({
          sessionId: manager.id,
          runId: root.runId,
          includeDescendants: true,
        }).attempts,
      ).toBe(1);
      expect(client.calls).toEqual([]);
      await session.prompt("new paid work");
      expect(client.calls).toHaveLength(1);
      expect(session.getStats().attempts).toBe(2);
      expect(session.getStats({ sessionId: session.sessionId }).attempts).toBe(
        1,
      );
      expect(session.getCostEntries({ sessionId: manager.id })).toEqual(
        history,
      );
    },
  );

  it("persists and resumes through SessionManager without resetting the public handle", async () => {
    const { session } = await make(new MockClient(), { persist: true });
    await session.prompt("persisted");
    const id = session.sessionId;
    expect(
      SessionManager.open(session.cwd, id)
        .getMessages()
        .some((message) => message.content === "persisted"),
    ).toBe(true);
    await session.newSession();
    await session.resume(id);
    expect(session.sessionId).toBe(id);
    await session.prompt("continued");
    expect(
      session.getMessages().some((message) => message.content === "persisted"),
    ).toBe(true);
  });

  it("cancels an owned approval interaction and queues before idempotent disposal settles", async () => {
    const requested = deferred();
    const { session } = await make(new MockClient([toolCall()]), {
      tools: [echo("write")],
      onPermissionRequest: () => {
        requested.resolve();
        return new Promise(() => undefined);
      },
    });
    const events: SessionEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });
    const running = session.prompt("write");
    await requested.promise;
    const queued = session.followUp("must not run");
    const dispose = session.dispose();
    expect(session.dispose()).toBe(dispose);
    await dispose;
    expect(await running).toMatchObject({ status: "aborted" });
    expect(await queued.completion).toMatchObject({ status: "aborted" });
    expect(
      events.findIndex((event) => event.type === "tool_result"),
    ).toBeLessThan(events.findIndex((event) => event.type === "run_settled"));
  });

  it("stops the previous run and clears old queued input when switching cwd", async () => {
    const started = deferred();
    const client = new MockClient([
      (signal) =>
        new Promise((resolve) => {
          started.resolve();
          signal?.addEventListener(
            "abort",
            () => {
              resolve([end]);
            },
            { once: true },
          );
        }),
    ]);
    const { session } = await make(client);
    const running = session.prompt("old");
    await started.promise;
    const queued = session.followUp("old queued");
    const nextCwd = join(dirname(getYukinoDir()), "other-project");
    mkdirSync(nextCwd);
    const manager = SessionManager.create(nextCwd, { persist: false });
    await session.switchSession(manager, { destination: nextCwd });
    expect(await running).toMatchObject({ status: "aborted" });
    expect(await queued.completion).toMatchObject({ status: "aborted" });
    expect(session.cwd).toBe(manager.cwd);
    expect(session.getMessages()).toEqual([]);
    expect((await session.prompt("new")).status).toBe("completed");
    expect(client.calls).toHaveLength(2);
  });

  it.each(["off", "only"] as const)(
    "registers MCP resources with %s tool presentation, changes exposure, and releases SDK ownership",
    async (mode) => {
      const disconnected = vi.fn(() => Promise.resolve());
      const mcp = new MCPManager({
        clientFactory: (config, apps, options) => {
          const client = new MCPClient(config, apps, options);
          vi.spyOn(client, "connect").mockResolvedValue();
          vi.spyOn(client, "disconnect").mockImplementation(disconnected);
          vi.spyOn(client, "listTools").mockResolvedValue([
            {
              name: "echo",
              description: "echo",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
            },
          ]);
          vi.spyOn(client, "readResource").mockResolvedValue({
            contents: [
              {
                uri: "mock://resource",
                mimeType: "text/plain",
                text: "portable resource",
              },
            ],
          });
          return client;
        },
      });
      const disconnectAll = vi.spyOn(mcp, "disconnectAll");
      const { session } = await make(new MockClient(), {
        mcpManager: mcp,
        tools: ["Bash", "McpReadResource", "McpResources"],
        onPermissionRequest: () => Promise.resolve("allow"),
      });
      await session.setSettings({ code_mode: { mode } });
      await session.registerMCPServer({
        name: "mock",
        command: "mock",
        exposure: "direct",
      });
      expect(session.getMCPState().connectedServers).toEqual(["mock"]);
      const resource = await session.readMCPResource("mock", "mock://resource");
      expect(resource.resourceArtifacts).toHaveLength(1);
      const metadata = session.getEntries().at(-1)?.message;
      expect(metadata?.type).toBe("mcp_resource");
      expect(metadata?.state).toBeUndefined();
      if (typeof metadata?.content !== "string") {
        throw new Error("Missing typed resource content metadata");
      }
      const artifact = resource.resourceArtifacts[0];
      expect(JSON.parse(metadata.content)).toEqual({
        server: "mock",
        uri: "mock://resource",
        artifacts: [
          {
            serverName: "mock",
            uri: "mock://resource",
            mimeType: artifact.mimeType,
            bytes: artifact.bytes,
            sha256: artifact.sha256,
            source: { type: "artifact", artifactId: artifact.id },
          },
        ],
      });
      expect(session.export({ scope: "tree", format: "jsonl" })).toContain(
        "artifact",
      );
      await session.setMCPExposure("mock", "hidden");
      await expect(
        session.readMCPResource("mock", "mock://resource"),
      ).rejects.toThrow();
      await session.dispose();
      expect(disconnectAll).not.toHaveBeenCalled();
      expect(disconnected).toHaveBeenCalledOnce();
      expect(mcp.states()).toEqual([]);
    },
  );

  it.each(["sdk", "rpc"] as const)(
    "%s cannot spawn stdio or contact HTTP without approval",
    async (entry) => {
      const { session } = await make(new MockClient(), { tools: ["Bash"] });
      const marker = join(cwd(), `unapproved-${entry}`);
      let requests = 0;
      const http = createServer((_request, response) => {
        requests++;
        response.writeHead(500).end();
      });
      await new Promise<void>((resolve) =>
        http.listen(0, "127.0.0.1", resolve),
      );
      try {
        const address = http.address();
        if (!address || typeof address === "string") {
          throw new Error("Missing test listener");
        }
        for (const config of [
          mcpConfig("stdio", marker),
          { name: "http", url: `http://127.0.0.1:${address.port}/mcp` },
        ]) {
          if (entry === "sdk") {
            await expect(session.registerMCPServer(config)).rejects.toThrow(
              /approval/,
            );
          } else {
            expect(
              await mcpRPC(session, "mcp_register", { config }),
            ).toMatchObject({ type: "response", success: false });
          }
        }
        expect(existsSync(marker)).toBe(false);
        expect(requests).toBe(0);
        expect(session.getMCPState().servers).toEqual([]);
      } finally {
        await new Promise<void>((resolve, reject) =>
          http.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          }),
        );
      }
    },
  );

  it("rejects HTTP redirects after explicit approval without contacting the redirect target", async () => {
    const requests: string[] = [];
    const http = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.writeHead(307, { Location: "/escaped" }).end();
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    try {
      const address = http.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing test listener");
      }
      const { session } = await make(new MockClient(), {
        onPermissionRequest: () => Promise.resolve("allow"),
      });
      await expect(
        session.registerMCPServer({
          name: "redirect",
          url: `http://127.0.0.1:${address.port}/mcp`,
          headers: { Authorization: "private-token" },
        }),
      ).rejects.toThrow("connection failed");
      expect(requests).toEqual(["/mcp"]);
      expect(session.getMCPState().servers).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        http.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        }),
      );
    }
  });

  it.each(["deny", "readonly", "revoked"] as const)(
    "%s cannot bypass Bash policy with MCP approval",
    async (restriction) => {
      const checker = new PermissionChecker(cwd(), "default");
      if (restriction === "readonly") {
        checker.readOnly = true;
      }
      if (restriction === "deny") {
        const check = checker.check.bind(checker);
        vi.spyOn(PermissionChecker.prototype, "check").mockImplementation(
          (name, category, args) =>
            name === "Bash"
              ? { effect: "deny", reason: "No spawning" }
              : check(name, category, args),
        );
      }
      const approval = vi.fn(() => {
        if (restriction === "revoked") {
          checker.mode = "plan";
        }
        return Promise.resolve("allow" as const);
      });
      const { session } = await make(new MockClient(), {
        tools: ["Bash"],
        permissions: checker,
        onPermissionRequest: approval,
      });
      const marker = join(cwd(), `blocked-${restriction}`);
      expect(
        await mcpRPC(session, "mcp_register", {
          config: mcpConfig("blocked", marker),
        }),
      ).toMatchObject({ success: false });
      expect(existsSync(marker)).toBe(false);
      expect(session.getMCPState().servers).toEqual([]);
      expect(approval).toHaveBeenCalledTimes(restriction === "revoked" ? 1 : 0);
    },
  );

  it("snapshots and redacts registrations, runs management/Bash hooks, and rolls back failed discovery", async () => {
    const previews: string[] = [];
    const hooks = vi.spyOn(HookEngine.prototype, "firePreToolHooks");
    let fail = false;
    const disconnected = vi.fn(() => Promise.resolve());
    const clients: MCPClient[] = [];
    const mcp = new MCPManager({
      clientFactory: (config, apps, options) => {
        const client = new MCPClient(config, apps, options);
        clients.push(client);
        vi.spyOn(client, "connect").mockResolvedValue();
        vi.spyOn(client, "disconnect").mockImplementation(disconnected);
        vi.spyOn(client, "listTools").mockImplementation(() =>
          fail
            ? Promise.reject(new Error("Discovery failed"))
            : Promise.resolve([]),
        );
        return client;
      },
    });
    const { session } = await make(new MockClient(), {
      mcpManager: mcp,
      tools: ["Bash"],
      onPermissionRequest: (_tool, args) => {
        previews.push(JSON.stringify(args));
        return Promise.resolve("allow");
      },
    });
    const input = {
      name: "http",
      url: "${ENDPOINT}",
      env: {
        ENDPOINT: "https://approved.invalid/mcp?token=header-secret",
        VALUE: "env-secret",
      },
      headers: { Authorization: "header-secret", Extra: "${VALUE}" },
    };
    const registering = session.registerMCPServer(input);
    input.name = "mutated";
    await registering;
    expect(mcp.getServerConfig("http")).toMatchObject({
      url: "https://approved.invalid/mcp?token=header-secret",
      headers: { Extra: "env-secret" },
      inherit_env: false,
    });
    const config = mcp.getServerConfig("http");
    if (config.env) {
      config.env.VALUE = "changed";
    }
    expect(mcp.getServerConfig("http").env?.VALUE).toBe("env-secret");
    expect(previews[0]).toContain("https://approved.invalid/mcp");
    expect(previews.join()).not.toMatch(/header-secret|env-secret/);
    expect(JSON.stringify(session.getMCPState())).not.toMatch(
      /header-secret|env-secret/,
    );
    expect(session.getMCPState().servers[0].source.scope).toBe("runtime");
    await session.registerMCPServer({
      name: "stdio",
      command: process.execPath,
      args: ["--token", "argument-secret"],
      env: { VALUE: "env-secret" },
      headers: { X: "header-secret" },
    });
    expect(hooks.mock.calls.map(([name]) => name)).toEqual([
      "MCPRegister",
      "MCPRegister",
      "Bash",
    ]);
    expect(JSON.stringify(hooks.mock.calls)).not.toMatch(
      /header-secret|env-secret|argument-secret/,
    );
    expect(previews).toHaveLength(2);
    fail = true;
    await expect(
      session.registerMCPServer({ name: "broken", command: process.execPath }),
    ).rejects.toThrow("MCP tool discovery failed");
    expect(mcp.state("broken")).toBeUndefined();
    expect(disconnected).toHaveBeenCalledOnce();
    fail = false;
    hooks.mockResolvedValueOnce({ rejected: true, reason: "blocked" });
    const before = clients.length;
    await expect(
      session.registerMCPServer({
        name: "hook-denied",
        command: process.execPath,
      }),
    ).rejects.toThrow("hook");
    expect(clients).toHaveLength(before);
    await session.registerMCPServer({
      name: "disabled",
      enabled: false,
      env: { TOKEN: "${MISSING_DISABLED_TOKEN}" },
    });
    expect(clients).toHaveLength(before);
    expect(mcp.state("disabled")?.state).toBe("registered");
    hooks.mockRestore();
  });

  it("keeps one MCP owner per runtime and snapshots reload, exposure, login and resource options before exclusion", async () => {
    const clients = new Map<string, MCPClient>();
    const mcp = new MCPManager({
      clientFactory: (config, apps, options) => {
        const client = new MCPClient(config, apps, options);
        clients.set(config.name, client);
        vi.spyOn(client, "connect").mockResolvedValue();
        vi.spyOn(client, "disconnect").mockResolvedValue();
        vi.spyOn(client, "listTools").mockResolvedValue([]);
        vi.spyOn(client, "listResourcesPage").mockResolvedValue({ items: [] });
        vi.spyOn(client, "listResourceTemplatesPage").mockResolvedValue({
          items: [],
        });
        vi.spyOn(client, "readResource").mockImplementation(
          async (_uri, signal) => {
            signal?.throwIfAborted();
            await Promise.resolve();
            return { contents: [] };
          },
        );
        return client;
      },
    });
    const { session } = await make(new MockClient(), {
      mcpManager: mcp,
      tools: ["McpResources", "McpReadResource"],
      onPermissionRequest: () => Promise.resolve("allow"),
    });
    await session.registerMCPServer({
      name: "first",
      url: "https://first.invalid/mcp",
    });
    await session.registerMCPServer({
      name: "second",
      url: "https://second.invalid/mcp",
    });
    expect(mcp.state("first")?.source).toBe(mcp.state("second")?.source);
    const config = { name: "second", url: "https://snapshot.invalid/mcp" };
    const reloading = session.reloadMCPServer("second", config);
    config.url = "https://mutated.invalid/mcp";
    await reloading;
    expect(mcp.getServerConfig("second").url).toBe(
      "https://snapshot.invalid/mcp",
    );
    const rules = [{ tool: "echo", exposure: "hidden" as const }];
    const changing = session.setMCPExposure("second", "direct", rules);
    rules[0].tool = "mutated";
    await changing;
    expect(mcp.getServerConfig("second").tool_exposure).toEqual([
      { tool: "echo", exposure: "hidden" },
    ]);
    const owned = new AbortController();
    const cancelled = new AbortController();
    cancelled.abort();
    const onAuthorization = vi.fn();
    const login = vi
      .spyOn(mcp, "login")
      .mockImplementation(async (_server, options, validate) => {
        options.signal?.throwIfAborted();
        validate?.();
        await options.onAuthorization(
          new URL("https://auth.invalid"),
          () => undefined,
        );
      });
    const loginOptions = { signal: owned.signal, onAuthorization };
    const loggingIn = session.loginMCP("second", loginOptions);
    loginOptions.signal = cancelled.signal;
    loginOptions.onAuthorization = vi.fn();
    await loggingIn;
    expect(onAuthorization).toHaveBeenCalledOnce();
    expect(loginOptions.onAuthorization).not.toHaveBeenCalled();
    expect(login.mock.calls[0][1].signal).not.toBe(owned.signal);
    const pageOptions = { templates: true, limit: 1, signal: owned.signal };
    const listing = session.listMCPResources("second", pageOptions);
    pageOptions.templates = false;
    pageOptions.limit = 99;
    pageOptions.signal = cancelled.signal;
    await listing;
    const client = clients.get("second");
    if (!client) {
      throw new Error("Missing local MCP client");
    }
    expect(vi.spyOn(client, "listResourcesPage").mock.calls).toEqual([]);
    expect(
      vi.spyOn(client, "listResourceTemplatesPage").mock.calls[0][0],
    ).toMatchObject({ templates: true, limit: 1 });
    const readOptions = { signal: owned.signal };
    const reading = session.readMCPResource(
      "second",
      "docs://snapshot",
      readOptions,
    );
    readOptions.signal = cancelled.signal;
    await reading;
    expect(vi.spyOn(client, "readResource").mock.calls).toHaveLength(1);
    const record = session.getEntries().at(-1)?.message;
    expect(record).toMatchObject({ role: "system", type: "mcp_resource" });
    expect(record?.state).toBeUndefined();
    if (typeof record?.content !== "string") {
      throw new Error("Missing resource content metadata");
    }
    expect(JSON.parse(record.content)).toEqual({
      server: "second",
      uri: "docs://snapshot",
      artifacts: [],
    });
    await session.unregisterMCPServer("first");
    expect(mcp.connectedServers()).toEqual(["second"]);
    await session.unregisterMCPServer("second");
    expect(mcp.states()).toEqual([]);
    await session.registerMCPServer({
      name: "next",
      url: "https://next.invalid/mcp",
    });
    const previousOwner = mcp.state("next")?.source;
    await session.newSession();
    expect(mcp.states()).toEqual([]);
    await session.registerMCPServer({
      name: "next",
      url: "https://next.invalid/mcp",
    });
    expect(mcp.state("next")?.source).not.toBe(previousOwner);
    await session.unregisterMCPServer("next");
  });

  it("rejects resource data when tool permission is denied during a borrowed-manager read", async () => {
    const gate = deferred();
    const started = deferred();
    let denied = false;
    const checker = new PermissionChecker(cwd(), "default");
    const check = checker.check.bind(checker);
    vi.spyOn(PermissionChecker.prototype, "check").mockImplementation(
      (name, category, args) =>
        denied && name === "McpReadResource"
          ? { effect: "deny", reason: "revoked" }
          : check(name, category, args),
    );
    const mcp = new MCPManager({
      clientFactory: (config, apps, options) => {
        const client = new MCPClient(config, apps, options);
        vi.spyOn(client, "connect").mockResolvedValue();
        vi.spyOn(client, "disconnect").mockResolvedValue();
        vi.spyOn(client, "listTools").mockResolvedValue([]);
        vi.spyOn(client, "readResource").mockImplementation(async () => {
          started.resolve();
          await gate.promise;
          return {
            contents: [{ uri: "docs://private", text: "private result" }],
          };
        });
        return client;
      },
    });
    const { session } = await make(new MockClient(), {
      mcpManager: mcp,
      tools: ["McpReadResource"],
      permissions: checker,
      onPermissionRequest: () => Promise.resolve("allow"),
    });
    await session.registerMCPServer({
      name: "resource",
      url: "https://fixture.invalid/mcp",
    });
    const reading = session.readMCPResource("resource", "docs://private");
    await started.promise;
    denied = true;
    gate.resolve();
    await expect(reading).rejects.toThrow("revoked");
    expect(
      session
        .getEntries()
        .filter((entry) => entry.message.type !== "session_runtime_state"),
    ).toEqual([]);
  });

  it("manages one borrowed server, continues RPC pages, preserves blob artifacts, and revokes reload approval", async () => {
    const mcp = new MCPManager();
    await mcp.connectAll([mcpConfig("host")]);
    let revoke = false;
    const { session } = await make(new MockClient(), {
      mcpManager: mcp,
      tools: ["Bash", "McpResources", "McpReadResource"],
      onPermissionRequest: async () => {
        if (revoke) {
          const source = mcp.state("owned")?.source;
          if (source) {
            await mcp.unregisterOwner(source);
          }
        }
        return "allow";
      },
    });
    try {
      await session.registerMCPServer(mcpConfig("owned"));
      expect(session.getMCPState().connectedServers).toEqual(["host", "owned"]);
      const host = mcp.getClient("host");
      await session.disconnectMCPServer("owned");
      expect(mcp.connectedServers()).toEqual(["host"]);
      await session.connectMCPServer("owned");
      const old = mcp.getClient("owned");
      await session.reloadMCPServer("owned");
      expect(mcp.getClient("owned")).not.toBe(old);
      expect(mcp.getClient("host")).toBe(host);
      await expect(old?.callTool("read", {})).rejects.toThrow();
      let cursor: string | undefined;
      const names: string[] = [];
      for (let index = 0; index < 3; index++) {
        const response = await mcpRPC(session, "mcp_resources", {
          server: "owned",
          limit: 1,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (response.type !== "response" || !response.success) {
          throw new Error("Resource page failed");
        }
        const page = z
          .object({
            items: z.array(z.object({ name: z.string() })),
            nextCursor: z.string().optional(),
          })
          .parse(response.result);
        names.push(...page.items.map((item) => item.name));
        cursor = page.nextCursor;
      }
      expect(names).toEqual(["one", "two", "three"]);
      expect(cursor).toBeUndefined();
      const templates = await session.listMCPResources("owned", {
        templates: true,
        limit: 1,
      });
      expect(templates.nextCursor).toBeTruthy();
      expect(
        (
          await session.listMCPResources("owned", {
            templates: true,
            cursor: templates.nextCursor,
            limit: 1,
          })
        ).items,
      ).toHaveLength(1);
      const blob = await session.readMCPResource("owned", "blob://binary");
      expect(blob.resourceArtifacts[0].bytes).toBe(20 * 1024);
      expect(blob.output).toContain("host artifact");
      expect(session.getEntries().at(-1)?.message.role).toBe("system");
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(
        session.readMCPResource("owned", "blob://cancelled", {
          signal: cancelled.signal,
        }),
      ).rejects.toThrow();
      for (const exposure of ["hidden", "codemode"] as const) {
        await session.setMCPExposure("owned", exposure);
        await expect(session.listMCPResources("owned")).rejects.toThrow();
        await expect(
          session.readMCPResource("owned", "blob://binary"),
        ).rejects.toThrow();
        for (const entry of [
          "direct",
          "dispatch",
          "app",
          "codemode",
          "resource",
        ] as const) {
          await expect(
            mcp.getClient("owned")?.callTool("read", {}, undefined, entry),
          ).rejects.toThrow();
        }
      }
      await session.setMCPExposure("owned", "direct");
      revoke = true;
      const marker = join(cwd(), "revoked-reload");
      await expect(
        session.reloadMCPServer("owned", mcpConfig("owned", marker)),
      ).rejects.toThrow(/revoked/);
      expect(existsSync(marker)).toBe(false);
      expect(mcp.connectedServers()).toEqual(["host"]);
      await session.dispose();
      expect(mcp.getClient("host")).toBe(host);
      expect(mcp.connectedServers()).toEqual(["host"]);
    } finally {
      await session.dispose();
      await mcp.disconnectAll();
    }
  });

  it("rejects user Bash authorization revoked while asynchronous pre-tool hooks are pending", async () => {
    const registry = new ToolRegistry();
    const tool = { ...echo("command"), name: "Bash" };
    registry.register(tool);
    const started = deferred(),
      finish = deferred();
    vi.spyOn(HookEngine.prototype, "firePreToolHooks").mockImplementation(
      async (name) => {
        if (name === "Bash") {
          started.resolve();
          await finish.promise;
        }
        return { rejected: false, reason: "" };
      },
    );
    const { session, client } = await make(new MockClient(), {
      registry,
      tools: ["Bash"],
      permissions: "bypassPermissions",
    });
    const running = session.userBash("must not execute");
    await started.promise;
    registry.unregister("Bash");
    registry.register(tool);
    finish.resolve();
    await expect(running).rejects.toThrow("authorization changed");
    expect(tool.execute).not.toHaveBeenCalled();
    expect(client.calls).toEqual([]);
    expect(
      session
        .getEntries()
        .filter((entry) => entry.message.type !== "session_runtime_state"),
    ).toEqual([]);
    await session.dispose();
    await registry.dispose();
  });

  it("executes user Bash through permissions and keeps excluded output out of model context", async () => {
    const { session, client } = await make(new MockClient(), {
      tools: ["Bash"],
      onPermissionRequest: () => Promise.resolve("allow"),
    });
    const result = await session.userBash("printf sdk-output", {
      excludeFromContext: true,
    });
    expect(result.output).toBe("sdk-output");
    expect(result.excludeFromContext).toBe(true);
    expect(session.getMessages()).toEqual([]);
    expect(
      session.getEntries().find((entry) => entry.message.user_bash)?.message
        .user_bash?.output,
    ).toBe("sdk-output");
    await session.prompt("continue");
    expect(client.calls[0].some((message) => message.userBash)).toBe(false);
  });

  it("skips untrusted project hooks/MCP with a custom client and no global provider loading", async () => {
    const directory = cwd();
    mkdirSync(join(directory, ".yukino"));
    writeFileSync(
      join(directory, ".yukino", "config.yaml"),
      "hooks:\n  - id: dangerous\n    event: session_start\n    action:\n      type: command\n      command: touch SHOULD_NOT_EXIST\nmcp_servers:\n  - name: dangerous\n    command: no-such-server\n",
    );
    const { session } = await make();
    await session.prompt("safe");
    expect(existsSync(join(directory, "SHOULD_NOT_EXIST"))).toBe(false);
    expect(session.getMCPState().connectedServers).toEqual([]);
  });
});
