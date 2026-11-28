import { PassThrough, Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  RPC_COMMANDS,
  RPC_MAX_LINE_BYTES,
  RPC_MAX_OUTPUT_BYTES,
  RPC_VERSION,
} from "@/rpc/constants.js";
import { JsonlDecoder, JsonlWriter } from "@/rpc/jsonl.js";
import { runRpcMode } from "@/rpc/mode.js";
import {
  parseRpcRequest,
  RpcMessageSchema,
  type RpcMessage,
} from "@/rpc/protocol.js";
import { RpcServer, type RpcHost } from "@/rpc/server.js";

const controls = vi.hoisted(() => ({
  sessionId: "session-123",
  cwd: "/rpc-test",
  isBusy: false,
  getQueueModes: vi.fn(() => ({
    steering: "all",
    followUp: "one-at-a-time",
  })),
  setQueueMode: vi.fn(),
  getRetryState: vi.fn<() => { reason: string; delay: number } | null>(
    () => null,
  ),
  getCodeModeState: vi.fn(() => ({
    activeToolCallIds: ["owned-code"],
    foregroundToolsRunning: true,
  })),
  stopCodeMode: vi.fn(() => Promise.resolve()),
  getWarmingState: vi.fn(() => ({ phase: "paused" })),
  stopWarming: vi.fn(() => Promise.resolve()),
  resumeWarming: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
  abort: vi.fn(() => Promise.resolve()),
  dispose: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/sdk/index.js", () => ({
  createAgentSession: () => Promise.resolve({ session: controls }),
}));
vi.mock("@/bootstrap/invocation.js", () => ({
  loadInvocation: () =>
    Promise.resolve({
      cwd: "/rpc-test",
      config: { providers: [], permission_mode: "default" },
    }),
}));
vi.mock("@/session/index.js", () => ({ listSessions: () => [] }));
vi.mock("@/session/manager.js", () => ({
  SessionManager: {
    create: () => ({ id: "session-123", cwd: "/rpc-test" }),
  },
}));

function fixture(handlers: RpcHost["handlers"] = {}) {
  const output = new PassThrough();
  const messages: RpcMessage[] = [];
  const watchers = new Set<(message: RpcMessage) => void>();
  output.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split("\n")) {
      const raw: unknown = JSON.parse(line);
      const message: RpcMessage = RpcMessageSchema.parse(raw);
      messages.push(message);
      for (const watcher of watchers) {
        watcher(message);
      }
    }
  });
  const abort = vi.fn();
  const host: RpcHost = {
    sessionId: () => "session-123",
    handlers,
    subscribe: () => () => undefined,
    abort,
    dispose: vi.fn(() => Promise.resolve()),
  };
  const server = new RpcServer(host, output);
  const next = (predicate: (message: RpcMessage) => boolean) =>
    new Promise<RpcMessage>((resolve, reject) => {
      const watcher = (message: RpcMessage): void => {
        if (predicate(message)) {
          clearTimeout(timer);
          watchers.delete(watcher);
          resolve(message);
        }
      };
      const timer = setTimeout(() => {
        watchers.delete(watcher);
        reject(new Error("RPC fixture message deadline exceeded"));
      }, 2000);
      watchers.add(watcher);
    });
  const send = (
    command: string,
    args: Record<string, unknown> = {},
    commandId = command,
  ): void => {
    server.receive(
      JSON.stringify({
        version: RPC_VERSION,
        type: "request",
        commandId,
        command,
        args,
      }),
    );
  };
  return { server, host, abort, output, messages, next, send };
}

describe("RPC framing", () => {
  it("decodes split Unicode and multiple frames", () => {
    const decoder = new JsonlDecoder();
    const bytes = Buffer.from('{"text":"雪"}\n{}\r\n');
    expect([
      ...decoder.push(bytes.subarray(0, 11)),
      ...decoder.push(bytes.subarray(11)),
      ...decoder.finish(),
    ]).toEqual(['{"text":"雪"}', "{}"]);
  });

  it("rejects oversized frames without losing the following request", () => {
    const decoder = new JsonlDecoder();
    expect(decoder.push("x".repeat(RPC_MAX_LINE_BYTES + 1))).toEqual([]);
    expect(decoder.push("discard\n{}\n")).toEqual(["{}"]);
    expect(decoder.takeErrors()).toBe(1);
  });

  it("accepts the exact byte limit when CRLF arrives in two chunks", () => {
    const decoder = new JsonlDecoder();
    const line = "é".repeat(RPC_MAX_LINE_BYTES / 2);
    expect(decoder.push(Buffer.from(line + "\r"))).toEqual([]);
    expect(decoder.push(Buffer.from("\n{}\n"))).toEqual([line, "{}"]);
    expect(decoder.takeErrors()).toBe(0);
  });

  it("counts an oversized unterminated line exactly once", () => {
    const decoder = new JsonlDecoder();
    decoder.push("x".repeat(RPC_MAX_LINE_BYTES + 1));
    decoder.push("trailing bytes");
    expect(decoder.finish()).toEqual([]);
    expect(decoder.takeErrors()).toBe(1);
    expect(decoder.finish()).toEqual([]);
    expect(decoder.takeErrors()).toBe(0);
  });

  it("accepts image-only steering and rejects empty queue inputs", () => {
    const request = {
      version: 1,
      type: "request",
      commandId: "image",
      command: "steer",
    };
    const attachments = [
      {
        type: "image",
        source: { type: "url", url: "https://example.invalid/screenshot.png" },
      },
    ];
    expect(
      parseRpcRequest({ ...request, args: { text: "", attachments } }).args,
    ).toEqual({ text: "", attachments });
    expect(() => parseRpcRequest({ ...request, args: { text: "" } })).toThrow();
  });

  it("validates envelopes and command parameters before execution", () => {
    expect(() =>
      parseRpcRequest({
        version: 1,
        type: "request",
        commandId: "id",
        command: "set_thinking",
        args: { level: "invalid" },
      }),
    ).toThrow();
    expect(() =>
      parseRpcRequest({
        version: 1,
        type: "request",
        commandId: "id",
        command: "prompt",
        args: { text: "task", trusted: true },
      }),
    ).toThrow();
    expect(() =>
      parseRpcRequest({
        version: 1,
        type: "request",
        commandId: "id",
        command: "abort",
        args: { scope: "task" },
      }),
    ).toThrow();
  });

  it.each(["steer", "follow_up"])(
    "accepts only explicit queue modes for %s",
    (kind) => {
      for (const mode of ["all", "one-at-a-time"]) {
        expect(
          parseRpcRequest({
            version: 1,
            type: "request",
            commandId: "mode",
            command: "set_queue_mode",
            args: { kind, mode },
          }).args,
        ).toEqual({ kind, mode });
      }
    },
  );

  it.each([
    {},
    { kind: "steer" },
    { mode: "all" },
    { kind: "followUp", mode: "all" },
    { kind: "steering", mode: "all" },
    { kind: "steer", mode: "invalid" },
    { kind: "steer", mode: "all", replay: true },
  ])("rejects invalid queue mode arguments: %j", (args) => {
    expect(() =>
      parseRpcRequest({
        version: 1,
        type: "request",
        commandId: "mode",
        command: "set_queue_mode",
        args,
      }),
    ).toThrow();
  });

  it.each([
    "get_queue_modes",
    "get_retry_state",
    "get_code_mode",
    "stop_code_mode",
    "get_warming_state",
    "stop_warming",
    "resume_warming",
  ])("rejects extraneous arguments to %s", (command) => {
    const request = { version: 1, type: "request", commandId: "id", command };
    expect(parseRpcRequest(request).args).toEqual({});
    expect(() =>
      parseRpcRequest({ ...request, args: { force: true } }),
    ).toThrow();
  });

  it("keeps the 1 MiB frame and 8 MiB pending output limits", async () => {
    expect(RPC_MAX_LINE_BYTES).toBe(1024 * 1024);
    expect(RPC_MAX_OUTPUT_BYTES).toBe(8 * 1024 * 1024);
    const output = new PassThrough();
    const writer = new JsonlWriter(output);
    await expect(
      writer.write({
        version: 1,
        type: "response",
        commandId: "too-large",
        success: true,
        result: "x".repeat(RPC_MAX_OUTPUT_BYTES),
      }),
    ).rejects.toThrow("backpressure limit");
    output.resume();
    const frame: RpcMessage = {
      version: RPC_VERSION,
      type: "response",
      commandId: "backlog",
      success: true,
      result: "x".repeat(RPC_MAX_LINE_BYTES / 2),
    };
    const pending = Array.from({ length: 15 }, () => writer.write(frame));
    await expect(writer.write(frame)).rejects.toThrow("backpressure limit");
    await Promise.all(pending);
    await writer.flush();
    writer.dispose();
    output.destroy();
  });

  it("waits for small writes and propagates asynchronous write failures", async () => {
    let complete!: (error?: Error | null) => void;
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        complete = callback;
      },
    });
    const writer = new JsonlWriter(output);
    let settled = false;
    const writing = writer.write({
      version: 1,
      type: "response",
      commandId: "small",
      success: true,
      result: null,
    });
    const assertion = expect(writing).rejects.toThrow("disk failed");
    void writing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    complete(new Error("disk failed"));
    await assertion;
    await expect(writer.flush()).rejects.toThrow("disk failed");
    writer.dispose();
  });

  it("rejects callback failures when a stream is destroyed without an error or close event", async () => {
    const output = new Writable({
      emitClose: false,
      write(_chunk, _encoding, callback) {
        this.destroy();
        callback(new Error("write cancelled"));
      },
    });
    const writer = new JsonlWriter(output);
    try {
      await expect(
        writer.write({
          version: 1,
          type: "response",
          commandId: "closed",
          success: true,
          result: null,
        }),
      ).rejects.toThrow("write cancelled");
      await expect(writer.flush()).rejects.toThrow("write cancelled");
    } finally {
      writer.dispose();
    }
  });

  it("preserves ordered output through backpressure", async () => {
    const chunks: string[] = [];
    const output = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString());
        queueMicrotask(callback);
      },
    });
    const writer = new JsonlWriter(output);
    await Promise.all(
      [1, 2, 3].map((number) =>
        writer.write({
          version: 1,
          type: "response",
          commandId: String(number),
          success: true,
          result: number,
        }),
      ),
    );
    await writer.flush();
    expect(
      chunks.map((chunk) => {
        const message = RpcMessageSchema.parse(JSON.parse(chunk));
        if (message.type !== "response") {
          throw new Error("Expected response");
        }
        return message.commandId;
      }),
    ).toEqual(["1", "2", "3"]);
    writer.dispose();
  });
});

describe("RPC SDK control handlers", () => {
  it("advertises and delegates controls without replaying or overriding policy", async () => {
    const f = fixture();
    await f.server.stop();
    const input = new PassThrough();
    vi.clearAllMocks();
    vi.stubGlobal("process", {
      stdin: input,
      stdout: f.output,
      env: process.env,
      exitCode: 0,
      once: process.once.bind(process),
      off: process.off.bind(process),
    });
    const initialized = f.next(
      (message) =>
        message.type === "event" &&
        z.object({ type: z.literal("initialized") }).safeParse(message.event)
          .success,
    );
    const running = runRpcMode({ persist: false });
    let number = 0;
    const query = async (command: string, args = {}) => {
      const commandId = `control-${number++}`;
      const response = f.next(
        (message) =>
          message.type === "response" &&
          (message.commandId === commandId || message.commandId === null),
      );
      input.write(
        JSON.stringify({
          version: 1,
          type: "request",
          commandId,
          command,
          args,
        }) + "\n",
      );
      return response;
    };
    try {
      await initialized;
      const advertised = await query("get_commands");
      expect(advertised).toMatchObject({ success: true });
      if (advertised.type !== "response" || !advertised.success) {
        throw new Error("Expected commands response");
      }
      expect(advertised.result).toEqual(
        expect.arrayContaining([...RPC_COMMANDS]),
      );
      expect(JSON.stringify(advertised)).not.toContain('"retry"');
      expect(await query("get_queue_modes")).toMatchObject({
        result: { steering: "all", followUp: "one-at-a-time" },
      });
      for (const kind of ["steer", "follow_up"]) {
        for (const mode of ["all", "one-at-a-time"]) {
          expect(await query("set_queue_mode", { kind, mode })).toMatchObject({
            success: true,
            result: null,
          });
          expect(controls.setQueueMode).toHaveBeenLastCalledWith(
            kind === "follow_up" ? "followUp" : "steer",
            mode,
          );
        }
      }
      expect(
        await query("set_queue_mode", { kind: "followUp", mode: "all" }),
      ).toMatchObject({ error: { code: "invalid_request" } });
      expect(controls.setQueueMode).toHaveBeenCalledTimes(4);
      controls.getRetryState.mockReturnValueOnce({
        reason: "rate limited",
        delay: 1000,
      });
      expect(await query("get_retry_state")).toMatchObject({
        result: { reason: "rate limited", delay: 1000 },
      });
      expect(await query("get_retry_state")).toMatchObject({ result: null });
      expect(await query("get_code_mode")).toMatchObject({
        result: {
          activeToolCallIds: ["owned-code"],
          foregroundToolsRunning: true,
        },
      });
      expect(await query("get_warming_state")).toMatchObject({
        result: { phase: "paused" },
      });
      for (const command of [
        "stop_code_mode",
        "stop_warming",
        "resume_warming",
      ]) {
        expect(await query(command)).toMatchObject({
          success: true,
          result: null,
        });
      }
      expect(controls.stopCodeMode).toHaveBeenCalledExactlyOnceWith();
      expect(controls.stopWarming).toHaveBeenCalledExactlyOnceWith();
      expect(controls.resumeWarming).toHaveBeenCalledExactlyOnceWith();
      expect(controls.abort).not.toHaveBeenCalled();
      controls.resumeWarming.mockImplementationOnce(() => {
        throw new Error("private credential");
      });
      expect(await query("resume_warming")).toMatchObject({
        success: false,
        error: { code: "execution_failed", message: "Command failed" },
      });
      expect(JSON.stringify(f.messages)).not.toContain("private credential");
    } finally {
      input.end();
      try {
        await running;
      } finally {
        vi.unstubAllGlobals();
      }
    }
    expect(controls.abort).toHaveBeenCalledExactlyOnceWith("all");
    expect(controls.dispose).toHaveBeenCalledOnce();
  });
});

describe("RPC control", () => {
  it("rejects only invalid requests and still answers valid queries", async () => {
    const getState = vi.fn(() => ({ idle: true }));
    const f = fixture({ get_state: getState });
    const invalid = f.next(
      (message) => message.type === "response" && !message.success,
    );
    f.server.receive('{"token":"private",');
    expect(await invalid).toMatchObject({
      commandId: null,
      error: { code: "invalid_request" },
    });
    const valid = f.next(
      (message) =>
        message.type === "response" && message.commandId === "get_state",
    );
    f.send("get_state");
    expect(await valid).toMatchObject({
      success: true,
      result: { idle: true },
    });
    expect(getState).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.messages)).not.toContain("private");
    await f.server.stop();
  });

  it("separates prompt acknowledgement from completion", async () => {
    let complete!: (value: unknown) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const f = fixture({
      prompt: () =>
        new Promise((resolve) => {
          complete = resolve;
          markStarted();
        }),
    });
    const ack = f.next((message) => message.type === "response");
    f.send("prompt", { text: "task" });
    expect(await ack).toMatchObject({
      success: true,
      result: { accepted: true },
    });
    await started;
    const settled = f.next((message) => message.type === "event");
    complete({ status: "completed", text: "done" });
    expect(await settled).toMatchObject({
      commandId: "prompt",
      event: { type: "command_completed", result: { text: "done" } },
    });
    await f.server.stop();
  });

  it("treats an unknown side-effect outcome as failed without retrying", async () => {
    const handler = vi.fn(() => {
      throw new Error("private provider credential");
    });
    const f = fixture({ bash: handler });
    const ack = f.next((message) => message.type === "response");
    f.send("bash", { command: "fixture-only" }, "effect");
    expect(await ack).toMatchObject({
      success: true,
      result: { accepted: true },
    });
    const failure = f.next((message) => message.type === "event");
    expect(await failure).toMatchObject({
      commandId: "effect",
      event: {
        type: "command_failed",
        error: { code: "execution_failed", message: "Command failed" },
      },
    });
    const duplicate = f.next((message) => message.type === "response");
    f.send("bash", { command: "fixture-only" }, "effect");
    expect(await duplicate).toMatchObject({
      error: { code: "invalid_request" },
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.messages)).not.toContain(
      "private provider credential",
    );
    await f.server.stop();
  });

  it("rejects duplicate command IDs without repeating side effects", async () => {
    const handler = vi.fn(() => "ok");
    const f = fixture({ name_session: handler });
    const first = f.next((message) => message.type === "response");
    f.send("name_session", { name: "name" }, "same");
    await first;
    const duplicate = f.next(
      (message) => message.type === "response" && !message.success,
    );
    f.send("name_session", { name: "name" }, "same");
    expect(await duplicate).toMatchObject({
      error: { code: "invalid_request" },
    });
    expect(handler).toHaveBeenCalledOnce();
    await f.server.stop();
  });

  it("binds interactions to sessions and validates single-use replies", async () => {
    const f = fixture();
    const event = f.next((message) => message.type === "interaction");
    const answer = f.server.requestInteraction(
      "permission",
      { tool: "WriteFile" },
      z.enum(["allow", "deny"]),
    );
    const message = await event;
    if (message.type !== "interaction") {
      throw new Error("Expected interaction");
    }
    const invalid = f.next((m) => m.type === "response");
    f.send(
      "interaction_response",
      {
        interactionId: message.interactionId,
        sessionId: "different",
        response: "allow",
      },
      "bad",
    );
    expect(await invalid).toMatchObject({
      error: { code: "stale_interaction" },
    });
    const valid = f.next(
      (m) => m.type === "response" && m.commandId === "good",
    );
    f.send(
      "interaction_response",
      {
        interactionId: message.interactionId,
        sessionId: message.sessionId,
        response: "deny",
      },
      "good",
    );
    expect(await answer).toBe("deny");
    expect(await valid).toMatchObject({ success: true });
    const replay = f.next(
      (m) => m.type === "response" && m.commandId === "replay",
    );
    f.send(
      "interaction_response",
      {
        interactionId: message.interactionId,
        sessionId: message.sessionId,
        response: "allow",
      },
      "replay",
    );
    expect(await replay).toMatchObject({
      error: { code: "stale_interaction" },
    });
    await f.server.stop();
  });

  it.each<{
    kind: string;
    schema: z.ZodType;
    response: unknown;
    invalid: unknown;
  }>([
    {
      kind: "ask_user",
      schema: z.record(z.string(), z.string()),
      response: { question: "No" },
      invalid: [],
    },
    {
      kind: "plan_approval",
      schema: z.union([
        z.enum(["approve", "deny"]),
        z.strictObject({ feedback: z.string() }),
      ]),
      response: { feedback: "revise" },
      invalid: { approve: true },
    },
    {
      kind: "project_trust",
      schema: z.enum(["once", "persistent", "deny"]),
      response: "deny",
      invalid: "allow",
    },
  ])(
    "validates and consumes $kind replies once",
    async ({ kind, schema, response, invalid }) => {
      const f = fixture();
      const event = f.next((message) => message.type === "interaction");
      const answer = f.server.requestInteraction(kind, {}, schema);
      const message = await event;
      if (message.type !== "interaction") {
        throw new Error("Expected interaction");
      }
      const respond = async (value: unknown, id: string) => {
        const result = f.next((message) => message.type === "response");
        f.send(
          "interaction_response",
          {
            interactionId: message.interactionId,
            sessionId: message.sessionId,
            response: value,
          },
          id,
        );
        return result;
      };
      expect(await respond(invalid, "invalid")).toMatchObject({
        error: { code: "stale_interaction" },
      });
      expect(await respond(response, "valid")).toMatchObject({ success: true });
      expect(await answer).toEqual(response);
      expect(await respond(response, "replay")).toMatchObject({
        error: { code: "stale_interaction" },
      });
      await f.server.stop();
    },
  );

  it("tolerates only its own premature stdin close during shutdown", async () => {
    const f = fixture();
    const input = new PassThrough();
    const running = f.server.run(input);
    await f.server.stop();
    await running;
    expect(f.abort).toHaveBeenCalledOnce();
    expect(f.host.dispose).toHaveBeenCalledOnce();

    const failed = fixture();
    const broken = new PassThrough();
    const reading = failed.server.run(broken);
    const rejection = expect(reading).rejects.toThrow(
      "unrelated input failure",
    );
    broken.destroy(new Error("unrelated input failure"));
    await rejection;
    expect(failed.host.dispose).toHaveBeenCalledOnce();
  });

  it("releases the host and writer even when RPC cancellation fails", async () => {
    const f = fixture();
    f.abort.mockImplementation(() => {
      throw new Error("abort failed");
    });
    const stopped = f.server.stop();
    expect(f.server.stop()).toBe(stopped);
    await expect(stopped).rejects.toThrow();
    expect(f.host.dispose).toHaveBeenCalledOnce();
    expect(f.output.listenerCount("error")).toBe(0);
  });

  it("settles pending commands and reports every shutdown failure", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture({ prompt: () => gate });
    const accepted = f.next((message) => message.type === "response");
    f.send("prompt", { text: "pending" });
    await accepted;
    const abortFailure = new Error("abort failed");
    const disposalFailure = new Error("dispose failed");
    f.abort.mockImplementation(() => {
      throw abortFailure;
    });
    vi.mocked(f.host.dispose).mockImplementation(() => {
      release();
      return Promise.reject(disposalFailure);
    });
    await expect(f.server.stop()).rejects.toMatchObject({
      errors: [abortFailure, disposalFailure],
    });
    expect(f.output.listenerCount("error")).toBe(0);
    expect(
      f.messages.some(
        (message) => message.type === "event" && message.commandId === "prompt",
      ),
    ).toBe(true);
  });

  it("cancels pending interactions and disposes once", async () => {
    const f = fixture();
    const event = f.next((message) => message.type === "interaction");
    const answer = f.server.requestInteraction("trust", {}, z.boolean());
    const rejected = expect(answer).rejects.toThrow("closed");
    await event;
    await Promise.all([f.server.stop(), f.server.stop()]);
    await rejected;
    expect(f.host.dispose).toHaveBeenCalledOnce();
  });
});
