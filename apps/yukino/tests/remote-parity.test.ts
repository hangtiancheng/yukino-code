import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { z } from "zod";

import { Agent } from "@yukino.js/agent";
import {
  globalConfigPath,
  type ProviderConfig,
} from "@yukino.js/config/provider-config.js";
import * as providerLogin from "@yukino.js/config/provider-login.js";
import * as historyMod from "@yukino.js/history";
import { MCPClient } from "@yukino.js/mcp/client.js";
import {
  createRemoteAgent,
  RemoteServer,
  type CreateRemoteAgentOptions,
} from "@yukino.js/remote/server.js";
import { loadSession, listSessions, saveUserMessage } from "@yukino.js/session";
import { writePrivateFileSync } from "@yukino.js/storage/private.js";
import type { Asker } from "@yukino.js/tools/ask-user.js";
import { contentToText } from "@yukino.js/utils";

interface Broadcast {
  type: string;
  data: unknown;
}

const MessageData = z.object({ message: z.string() });
const OutputData = z.object({ output: z.string() });
const ListData = z.object({ list: z.array(z.unknown()) });
const PathData = z.object({ path: z.string() });
const ClientIdData = z.object({ clientId: z.string() });
const ContentData = z.object({ content: z.string() });
const ModelData = z.object({ model: z.string() });
const ToolUseData = z.object({ toolName: z.string() });

const provider: ProviderConfig = {
  name: "test",
  protocol: "openai",
  base_url: "https://example.invalid",
  api_key: "test",
  model: "test-model",
};

function invokePrivate(
  target: object,
  methodName: string,
  args: unknown[] = [],
): unknown {
  const method: unknown = Reflect.get(target, methodName);
  if (typeof method !== "function") {
    throw new Error(`Missing method: ${methodName}`);
  }
  return Reflect.apply(method, target, args);
}

async function invokePrivateAsync(
  target: object,
  methodName: string,
  args: unknown[] = [],
): Promise<void> {
  const result = invokePrivate(target, methodName, args);
  if (result instanceof Promise) {
    await result;
  }
}

function captureBroadcasts(server: RemoteServer): Broadcast[] {
  const messages: Broadcast[] = [];
  Reflect.set(server, "broadcast", (message: Broadcast) => {
    messages.push(message);
  });
  return messages;
}

function systemText(broadcasts: Broadcast[]): string {
  return broadcasts
    .filter((message) => message.type === "system")
    .map((message) => MessageData.parse(message.data).message)
    .join("\n");
}

async function setup(cwd: string): Promise<{
  server: RemoteServer;
  handle: Awaited<ReturnType<typeof createRemoteAgent>>;
  broadcasts: Broadcast[];
}> {
  const server = new RemoteServer({
    providers: [provider],
    addr: ":18888",
    enableCoordinatorMode: false,
    forkDisabled: true,
    memoryEnabled: false,
  });
  const broadcasts = captureBroadcasts(server);
  const handle = await createRemoteAgent({
    provider,
    cwd,
    enableCoordinatorMode: false,
    forkDisabled: true,
    memoryEnabled: false,
  });
  Reflect.set(server, "agentHandle", handle);
  return { server, handle, broadcasts };
}

describe("remote terminal-UI parity", () => {
  it("keeps configured MCP loading through initialization, switching and reload", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-mcp-loading-"));
    vi.spyOn(MCPClient.prototype, "connect").mockResolvedValue();
    vi.spyOn(MCPClient.prototype, "listTools").mockResolvedValue([
      {
        name: "echo",
        description: "Echo",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    const mcpServers = [{ name: "test", command: "unused" }];
    let handle: Awaited<ReturnType<typeof createRemoteAgent>> | undefined;
    const factory = vi.fn(async (options: CreateRemoteAgentOptions) => {
      handle = await createRemoteAgent({ ...options, cwd });
      return handle;
    });
    const server = new RemoteServer({
      providers: [provider],
      addr: ":18888",
      mcpServers,
      mcpLoading: "dispatch",
      enableCoordinatorMode: false,
      forkDisabled: true,
      memoryEnabled: false,
      agentFactory: factory,
    });
    try {
      await invokePrivateAsync(server, "ensureAgent");
      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({ mcpLoading: "dispatch" }),
      );
      if (!handle) {
        throw new Error("Expected the remote agent");
      }
      const registry = handle.registry;
      expect(registry.mcpLoadingMode).toBe("dispatch");
      await invokePrivateAsync(server, "applyProviderSwitch", [0]);
      expect(registry.mcpLoadingMode).toBe("dispatch");
      await invokePrivateAsync(server, "applyModel", ["next-model"]);
      expect(registry.mcpLoadingMode).toBe("dispatch");
      writePrivateFileSync(
        globalConfigPath(),
        JSON.stringify({
          providers: [provider],
          mcp_servers: mcpServers,
        }),
      );
      await invokePrivateAsync(server, "reloadMcpServers");
      expect(registry.mcpLoadingMode).toBe("dispatch");
      expect(registry.exposeMcpCall).toBe(true);
      expect(
        registry.listTools().some((tool) => tool.name.startsWith("mcp__")),
      ).toBe(true);
    } finally {
      await server.stop();
      vi.restoreAllMocks();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("binds steering received during cold initialization when its queued turn is dispatched", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-cold-steering-"));
    const { server, handle } = await setup(cwd);
    const run = vi
      .spyOn(Agent.prototype, "run")
      .mockImplementation(async function* () {
        await Promise.resolve();
        yield { type: "loop_complete", stopReason: "end_turn" };
      });
    try {
      Reflect.set(server, "agentHandle", null);
      Reflect.set(server, "streaming", true);
      invokePrivate(server, "handleSteeringMessage", ["cold follow-up"]);
      expect(historyMod.loadInputs()).toHaveLength(0);
      Reflect.set(server, "agentHandle", handle);
      Reflect.set(server, "streaming", false);
      await invokePrivateAsync(server, "drainFollowUps");
      expect(historyMod.loadInputs().map((input) => input.sessionId)).toEqual([
        handle.sessionId,
      ]);
      expect(loadSession(cwd, handle.sessionId)[0].user_input?.id).toBe(
        historyMod.loadInputs()[0].id,
      );
    } finally {
      Reflect.set(server, "agentHandle", handle);
      run.mockRestore();
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps /resume ordering stable when opening an older session without sending a message", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-resume-order-"));
    const { server, broadcasts } = await setup(cwd);
    try {
      for (const [id, timestamp] of [
        ["older", 1000],
        ["newer", 2000],
      ] as const) {
        const input = historyMod.recordInput({
          text: id,
          cwd,
          sessionId: id,
          source: "cli",
        });
        saveUserMessage(cwd, id, { ...input, timestamp }, { content: id });
      }
      await invokePrivateAsync(server, "handleUserMessage", ["/resume"]);
      await invokePrivateAsync(server, "handleUserMessage", ["/resume older"]);
      await invokePrivateAsync(server, "handleUserMessage", ["/resume"]);
      const schema = z.object({
        sessions: z.array(
          z.object({
            id: z.string(),
            lastUserMessageTime: z.string().nullable(),
          }),
        ),
      });
      const lists = broadcasts
        .filter((message) => message.type === "session_list")
        .map((message) => schema.parse(message.data));
      expect(lists).toHaveLength(2);
      expect(lists[0]).toEqual(lists[1]);
      expect(lists[1].sessions.map((session) => session.id)).toEqual([
        "newer",
        "older",
      ]);
      expect(listSessions(cwd)[1].lastUserMessageTime?.getTime()).toBe(1000);
      expect(historyMod.getCommandUsage().resume.usageCount).toBe(3);
    } finally {
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    { agent: "review", outcome: "complete" },
    { agent: "review", outcome: "cancel" },
    { agent: "review", outcome: "fail" },
    { agent: "plan", outcome: "complete" },
    { agent: "plan", outcome: "cancel" },
    { agent: "plan", outcome: "fail" },
  ])(
    "runs /$agent as a synchronous child through the browser command path ($outcome)",
    async ({ agent, outcome }) => {
      const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-review-"));
      const { server, handle, broadcasts } = await setup(cwd);
      handle.conv.addUserMessage("PARENT_CONTEXT");
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const run = vi.spyOn(Agent.prototype, "run").mockImplementation(function (
        this: Agent,
      ) {
        const conversation: unknown = Reflect.get(this, "conversation");
        expect(conversation).not.toBe(handle.conv);
        expect(JSON.stringify(conversation).includes("PARENT_CONTEXT")).toBe(
          agent === "plan",
        );
        if (agent === "plan") {
          const checker: unknown = Reflect.get(this, "checker");
          expect(checker).toMatchObject({ readOnly: true });
        }
        const signal: unknown = Reflect.get(this, "abortSignal");
        if (!(signal instanceof AbortSignal)) {
          throw new Error("Missing review cancellation signal");
        }
        signal.addEventListener("abort", release, { once: true });
        return (async function* () {
          await waiting;
          if (outcome === "fail") {
            throw new Error("Review could not read the PR");
          }
          if (outcome === "complete") {
            yield {
              type: "stream_text" as const,
              text: "Finding: src/auth.ts:12 accepts an expired token.",
            };
          }
          yield {
            type: "loop_complete" as const,
            stopReason: signal.aborted ? "interrupted" : "end_turn",
          };
        })();
      });
      try {
        const pending = invokePrivateAsync(server, "handleUserMessage", [
          `/${agent} 42`,
        ]);
        await vi.waitFor(() => {
          expect(run).toHaveBeenCalledOnce();
        });
        expect(Reflect.get(server, "streaming")).toBe(true);
        const toolUse = broadcasts.find(
          (message) => message.type === "tool_use",
        )?.data;
        expect(toolUse).toMatchObject({
          toolName: "Agent",
          args: { subagent_type: agent, run_in_background: false },
        });
        const input = z
          .object({ args: z.object({ prompt: z.string() }) })
          .parse(toolUse);
        expect(input.args.prompt).toContain("42");
        expect(
          broadcasts.some((message) => message.type === "loop_complete"),
        ).toBe(false);
        if (outcome === "cancel") {
          invokePrivate(server, "cancelActiveRun");
        } else {
          release();
        }
        await pending;
        expect(Reflect.get(server, "streaming")).toBe(false);
        expect(run).toHaveBeenCalledOnce();
        expect(
          broadcasts.some(
            (message) => message.type === "plan_approval_request",
          ),
        ).toBe(agent === "plan" && outcome === "complete");
        expect(
          loadSession(cwd, handle.sessionId)
            .filter((message) => message.role === "user")
            .map((message) => message.content),
        ).toEqual([`/${agent} 42`]);
        expect(
          broadcasts.find((message) => message.type === "loop_complete")?.data,
        ).toMatchObject({
          stopReason:
            outcome === "cancel"
              ? "interrupted"
              : outcome === "fail"
                ? "error"
                : "end_turn",
        });
        if (outcome === "complete") {
          expect(handle.conv.getMessages().at(-1)?.content).toContain(
            "expired token",
          );
          expect(broadcasts).toContainEqual(
            expect.objectContaining({
              type: "stream_end",
              data: {
                text: "Finding: src/auth.ts:12 accepts an expired token.",
              },
            }),
          );
        } else if (outcome === "fail") {
          const result = broadcasts.find(
            (message) => message.type === "tool_result",
          )?.data;
          expect(result).toMatchObject({ isError: true });
          expect(OutputData.parse(result).output).toContain(
            "could not read the PR",
          );
        }
      } finally {
        release();
        run.mockRestore();
        await server.stop();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it("rejects a stale plan approval without consuming the current request", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-plan-identity-"));
    const { server, handle, broadcasts } = await setup(cwd);
    try {
      invokePrivate(server, "broadcastPlanApprovalRequest");
      const oldId: unknown = Reflect.get(server, "planApprovalId");
      invokePrivate(server, "broadcastPlanApprovalRequest");
      const currentId: unknown = Reflect.get(server, "planApprovalId");
      const timer: unknown = Reflect.get(server, "planApprovalTimer");
      await invokePrivateAsync(server, "handlePlanApprovalResponse", [
        oldId,
        "yolo",
      ]);
      expect(Reflect.get(server, "planApprovalId")).toBe(currentId);
      expect(Reflect.get(server, "planApprovalTimer")).toBe(timer);
      expect(handle.permissionMode).toBe("default");
      expect(systemText(broadcasts)).not.toContain("Plan approved");
    } finally {
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("initializes notification runs without the preceding plan completion state", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-notification-plan-"));
    const { server } = await setup(cwd);
    Reflect.set(server, "exitPlanSucceeded", true);
    Reflect.set(server, "streamAgentRun", () => {
      expect(Reflect.get(server, "exitPlanSucceeded")).toBe(false);
      return Promise.resolve();
    });
    try {
      await invokePrivateAsync(server, "runNotificationTurn");
    } finally {
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("settles only the question belonging to an aborted caller", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-ask-abort-"));
    const { server, broadcasts } = await setup(cwd);
    const callback = invokePrivate(server, "createAskUserCallback");
    if (typeof callback !== "function") {
      throw new Error("Missing question callback");
    }
    const ask: Asker = (questions, signal) => {
      const answer: unknown = Reflect.apply(callback, server, [
        questions,
        signal,
      ]);
      if (!(answer instanceof Promise)) {
        throw new Error("Expected question promise");
      }
      return answer.then((value: unknown) =>
        z.record(z.string(), z.string()).parse(value),
      );
    };
    const controller = new AbortController();
    try {
      const answer = ask([], controller.signal);
      const second = ask([]);
      controller.abort();
      await expect(answer).resolves.toEqual({});
      expect(Reflect.get(server, "pendingAsks")).toHaveProperty("size", 1);
      expect(
        broadcasts.filter((message) => message.type === "request_expired"),
      ).toHaveLength(1);
      invokePrivate(server, "cancelActiveRun");
      await expect(second).resolves.toEqual({});
    } finally {
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("keeps an active run's slot when an unrelated WS request fails", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-slot-"));
    const { server, broadcasts } = await setup(cwd);
    Reflect.set(server, "streaming", true);
    const replies: Broadcast[] = [];
    Reflect.set(server, "send", (_ws: unknown, message: Broadcast) =>
      replies.push(message),
    );
    Reflect.set(server, "sendFileCompletions", () => {
      throw new Error("scan failed");
    });
    try {
      await invokePrivateAsync(server, "handleWsMessage", [
        {},
        {
          type: "file_complete_request",
          data: { requestId: "completion-1", query: "x" },
        },
      ]);
      expect(Reflect.get(server, "streaming")).toBe(true);
      expect(systemText(replies)).toContain("scan failed");
      expect(
        broadcasts.some((message) => message.type === "command_done"),
      ).toBe(false);
    } finally {
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("cancels the plan timer and broadcasts settlement for every waiting request", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-cancel-"));
    const { server, broadcasts } = await setup(cwd);
    vi.useFakeTimers();
    const permission = vi.fn();
    const ask = vi.fn();
    Reflect.set(
      server,
      "pendingPermissions",
      new Map([["permission-1", permission]]),
    );
    Reflect.set(server, "pendingAsks", new Map([["ask-1", ask]]));
    try {
      invokePrivate(server, "broadcastPlanApprovalRequest");
      invokePrivate(server, "cancelActiveRun");
      expect(Reflect.get(server, "planApprovalTimer")).toBeNull();
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
      expect(systemText(broadcasts)).not.toContain("Plan approval expired");
      expect(permission).toHaveBeenCalledExactlyOnceWith("deny");
      expect(ask).toHaveBeenCalledExactlyOnceWith({});
      expect(
        broadcasts.filter((message) => message.type === "request_expired"),
      ).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("preserves the session if teammates cannot stop during clear", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-clear-failure-"));
    const { server, handle, broadcasts } = await setup(cwd);
    const oldSession = handle.sessionId;
    handle.conv.addUserMessage("keep this history");
    const stop = vi
      .spyOn(handle.teamManager, "stopAll")
      .mockRejectedValue(new Error("cannot stop"));
    try {
      await invokePrivateAsync(server, "handleUserMessage", ["/clear"]);
      expect(handle.sessionId).toBe(oldSession);
      expect(
        contentToText(handle.conv.getMessages().at(-1)?.content ?? ""),
      ).toContain("keep this history");
      expect(broadcasts.some((message) => message.type === "clear")).toBe(
        false,
      );
    } finally {
      stop.mockRestore();
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("waits for owned memory tasks before clear and server disposal", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-memory-stop-"));
    const { server, handle } = await setup(cwd);
    let release: () => void = () => undefined;
    const dispose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    Reflect.set(handle, "memoryTasks", { dispose });
    const oldSession = handle.sessionId;
    const clearing = handle.clearConversation();
    expect(dispose).toHaveBeenCalledOnce();
    expect(handle.sessionId).toBe(oldSession);
    release();
    await clearing;
    expect(handle.sessionId).not.toBe(oldSession);
    const stopped = vi.fn(() => Promise.resolve());
    Reflect.set(handle, "memoryTasks", { dispose: stopped });
    await server.stop();
    expect(stopped).toHaveBeenCalledOnce();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("uses unique snapshot identities even within one millisecond", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-snapshot-"));
    const { server, handle } = await setup(cwd);
    vi.useFakeTimers();
    try {
      handle.fileHistory.makeSnapshot(1, "first");
      handle.fileHistory.makeSnapshot(2, "second");
      const [first, second] = handle.fileHistory.getSnapshots();
      expect(first.timestamp).toBe(second.timestamp);
      expect(first.id).not.toBe(second.id);
      invokePrivate(server, "handleRewindAction", [second.id, "code_only"]);
      expect(handle.fileHistory.getSnapshots()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("runs ! commands through the Bash tool and records them", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-bash-"));
    const { server, handle, broadcasts } = await setup(cwd);
    try {
      await invokePrivateAsync(server, "handleUserMessage", [
        "!echo remote-bash-ok",
      ]);
      const toolUse = broadcasts.find((message) => message.type === "tool_use");
      expect(
        broadcasts.filter((message) => message.type === "run_state"),
      ).toEqual([
        { type: "run_state", data: { streaming: true } },
        { type: "run_state", data: { streaming: false } },
      ]);
      expect(ToolUseData.parse(toolUse?.data).toolName).toBe("Bash");
      const toolResult = broadcasts.find(
        (message) => message.type === "tool_result",
      );
      expect(OutputData.parse(toolResult?.data).output).toContain(
        "remote-bash-ok",
      );
      // The user-bash result is recorded in the session and the conversation.
      const saved = loadSession(cwd, handle.sessionId);
      expect(
        saved.some(
          (message) => message.user_bash?.command === "echo remote-bash-ok",
        ),
      ).toBe(true);
      const convText = handle.conv
        .getMessages()
        .map((message) => contentToText(message.content))
        .join("\n");
      expect(convText).toContain("User executed Bash");
      // No user bubble for bash runs (the tool card carries the command).
      expect(broadcasts.some((message) => message.type === "replay_user")).toBe(
        false,
      );
    } finally {
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps !! commands out of the model context", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-bash2-"));
    const { server, handle, broadcasts } = await setup(cwd);
    try {
      await invokePrivateAsync(server, "handleUserMessage", [
        "!!echo excluded-run",
      ]);
      const saved = loadSession(cwd, handle.sessionId);
      const recorded = saved.find((message) => message.user_bash !== undefined);
      expect(recorded?.user_bash?.excludeFromContext).toBe(true);
      const convText = handle.conv
        .getMessages()
        .map((message) => contentToText(message.content))
        .join("\n");
      expect(convText).not.toContain("User executed Bash");
      const toolResult = broadcasts.find(
        (message) => message.type === "tool_result",
      );
      expect(OutputData.parse(toolResult?.data).output).toContain(
        "excluded-run",
      );
    } finally {
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("expands @refs for the conversation while replaying the raw text", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-at-"));
    writeFileSync(join(cwd, "notes.txt"), "EXPANDED-CONTENT");
    const { server, handle, broadcasts } = await setup(cwd);
    const run = vi.spyOn(Agent.prototype, "run").mockImplementation(function (
      this: Agent,
    ) {
      return (async function* () {
        await Promise.resolve();
        yield { type: "loop_complete" as const, stopReason: "end_turn" };
      })();
    });
    try {
      await invokePrivateAsync(server, "handleUserMessage", [
        "check @notes.txt",
      ]);
      const replay = broadcasts.find(
        (message) => message.type === "replay_user",
      );
      expect(ContentData.parse(replay?.data).content).toBe("check @notes.txt");
      const convText = handle.conv
        .getMessages()
        .map((message) => contentToText(message.content))
        .join("\n");
      expect(convText).toContain("EXPANDED-CONTENT");
      const saved = loadSession(cwd, handle.sessionId);
      expect(contentToText(saved[0]?.content ?? "")).toContain(
        "EXPANDED-CONTENT",
      );
    } finally {
      run.mockRestore();
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("queues slash commands sent mid-run as follow-ups and drains them", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-followup-"));
    const { server, broadcasts } = await setup(cwd);
    try {
      Reflect.set(server, "streaming", true);
      await invokePrivateAsync(server, "handleSteeringMessage", ["/status"]);
      expect(Reflect.get(server, "followUps")).toEqual([
        { text: "/status", input: undefined },
      ]);
      const queued = broadcasts.find((message) => message.type === "followups");
      expect(ListData.parse(queued?.data).list).toEqual(["/status"]);

      Reflect.set(server, "streaming", false);
      await invokePrivateAsync(server, "drainFollowUps");
      expect(Reflect.get(server, "followUps")).toEqual([]);
      expect(systemText(broadcasts)).toContain("Mode:");
    } finally {
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("applies permission mode changes with plan entry and exit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-mode-"));
    const { server, handle, broadcasts } = await setup(cwd);
    try {
      invokePrivate(server, "applyPermissionMode", ["acceptEdits"]);
      expect(handle.permissionMode).toBe("acceptEdits");

      invokePrivate(server, "applyPermissionMode", ["plan"]);
      expect(handle.permissionMode).toBe("plan");
      expect(systemText(broadcasts)).toContain("Entered plan mode");

      invokePrivate(server, "applyPermissionMode", ["default"]);
      expect(handle.permissionMode).toBe("default");
      expect(systemText(broadcasts)).toContain("Exited plan mode");
      const convText = handle.conv
        .getMessages()
        .map((message) => contentToText(message.content))
        .join("\n");
      expect(convText).toContain("<system-reminder>");
    } finally {
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rewinds the conversation to a checkpoint", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-rewind-"));
    const { server, handle, broadcasts } = await setup(cwd);
    try {
      handle.conv.addUserMessage("keep me");
      handle.conv.addUserMessage("drop me");
      handle.fileHistory.makeSnapshot(1, "drop me");

      // Rewind resolves by stable snapshot id (timestamp), not array index.
      const snapshotId = handle.fileHistory.getSnapshots()[0].id;
      invokePrivate(server, "handleRewindAction", [
        snapshotId,
        "conversation_only",
      ]);

      const convText = handle.conv
        .getMessages()
        .map((message) => contentToText(message.content))
        .join("\n");
      expect(convText).toContain("keep me");
      expect(convText).not.toContain("drop me");
      expect(broadcasts.some((message) => message.type === "clear")).toBe(true);
      const replayed = broadcasts
        .filter((message) => message.type === "replay_user")
        .map((message) => ContentData.parse(message.data).content);
      expect(replayed).toContain("keep me");
      expect(systemText(broadcasts)).toContain("Rewound conversation");
    } finally {
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reports missing checkpoints for /rewind", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-rewind2-"));
    const { server, broadcasts } = await setup(cwd);
    try {
      invokePrivate(server, "broadcastRewindList");
      expect(systemText(broadcasts)).toContain("No checkpoints");
    } finally {
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("switches the model and persists it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-model-"));
    const { server, handle, broadcasts } = await setup(cwd);
    try {
      // persistModel only saves when the provider exists in the global config.
      await invokePrivateAsync(server, "handleProviderSave", [
        { ...provider, api_key: "test" },
      ]);
      broadcasts.length = 0;
      await invokePrivateAsync(server, "applyModel", ["new-model"]);
      expect(handle.provider.model).toBe("new-model");
      expect(systemText(broadcasts)).toContain(
        "Model set to new-model and saved",
      );
      const status = broadcasts.find((message) => message.type === "status");
      expect(ModelData.parse(status?.data).model).toBe("new-model");
    } finally {
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("saves a provider from the browser form and activates it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-provider-"));
    const { server, handle, broadcasts } = await setup(cwd);
    try {
      await invokePrivateAsync(server, "handleProviderSave", [
        {
          name: "saved",
          protocol: "openai",
          base_url: "https://saved.invalid",
          api_key: "key",
          model: "saved-model",
        },
      ]);
      expect(handle.provider.name).toBe("saved");
      expect(handle.provider.model).toBe("saved-model");
      expect(systemText(broadcasts)).toContain(
        "Provider switched to saved · saved-model",
      );
    } finally {
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("activates replacement credentials and model for the current provider", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-replace-provider-"));
    const { server, handle } = await setup(cwd);
    const previousClient = handle.client;
    try {
      await invokePrivateAsync(server, "handleProviderSave", [
        { ...provider, api_key: "replacement-key", model: "replacement-model" },
      ]);
      expect(handle.provider.api_key).toBe("replacement-key");
      expect(handle.provider.model).toBe("replacement-model");
      expect(handle.client).not.toBe(previousClient);
    } finally {
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("opens login without a provider and initializes after saving one", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-first-login-"));
    const agentFactory = vi.fn(
      (options: Parameters<typeof createRemoteAgent>[0]) =>
        createRemoteAgent({ ...options, cwd }),
    );
    const server = new RemoteServer({
      providers: [],
      addr: "127.0.0.1:0",
      agentFactory,
      enableCoordinatorMode: false,
      forkDisabled: true,
      memoryEnabled: false,
    });
    const broadcasts = captureBroadcasts(server);
    try {
      await invokePrivateAsync(server, "handleUserMessage", ["/login"]);
      expect(agentFactory).not.toHaveBeenCalled();
      expect(broadcasts).toContainEqual({
        type: "provider_list",
        data: { providers: [], current: 0 },
      });
      await invokePrivateAsync(server, "handleProviderSave", [provider]);
      expect(agentFactory).toHaveBeenCalledOnce();
      expect(systemText(broadcasts)).toContain("Provider switched to test");
      expect(broadcasts.some((message) => message.type === "connected")).toBe(
        true,
      );
    } finally {
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("broadcasts the runtime provider switch when default persistence fails", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-provider-persist-"));
    const { server, handle, broadcasts } = await setup(cwd);
    const persist = vi
      .spyOn(providerLogin, "persistDefaultProvider")
      .mockImplementation(() => {
        throw new Error("read-only configuration");
      });
    try {
      await invokePrivateAsync(server, "handleProviderSave", [
        { ...provider, base_url: "https://other.invalid", name: "other" },
      ]);
      expect(handle.provider.name).toBe("other");
      expect(broadcasts.some((message) => message.type === "status")).toBe(
        true,
      );
      expect(systemText(broadcasts)).toContain(
        "Default provider could not be saved",
      );
    } finally {
      persist.mockRestore();
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(["handleUserMessage", "runNotificationTurn"])(
    "replays steering queued at the end of %s exactly once",
    async (method) => {
      const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-late-steering-"));
      const { server, handle, broadcasts } = await setup(cwd);
      let lateQueued = false;
      Reflect.set(server, "broadcast", (message: Broadcast) => {
        broadcasts.push(message);
        if (message.type === "loop_complete" && !lateQueued) {
          lateQueued = true;
          invokePrivate(server, "handleSteeringMessage", ["late message"]);
        }
      });
      const run = vi
        .spyOn(Agent.prototype, "run")
        .mockImplementation(async function* () {
          await Promise.resolve();
          yield { type: "loop_complete", stopReason: "end_turn" };
        });
      try {
        await invokePrivateAsync(
          server,
          method,
          method === "handleUserMessage" ? ["initial"] : [],
        );
        expect(run).toHaveBeenCalledTimes(2);
        expect(handle.takeSteeringLeftovers()).toEqual([]);
        expect(
          handle.conv
            .getMessages()
            .filter((message) => message.role === "user")
            .map((message) => contentToText(message.content)),
        ).toEqual(
          method === "handleUserMessage"
            ? ["initial", "late message"]
            : ["late message"],
        );
        expect(
          historyMod
            .loadInputTexts()
            .filter((entry) => entry === "late message"),
        ).toHaveLength(1);
      } finally {
        run.mockRestore();
        await server.stop();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it.each(["delivered", "canceled"])(
    "removes %s steering history markers before a later identical prompt",
    async (status) => {
      const cwd = mkdtempSync(
        join(tmpdir(), "yukino-remote-steering-history-"),
      );
      const { server, handle } = await setup(cwd);
      const steer = vi.spyOn(handle, "steer").mockReturnValue(true);
      const run = vi
        .spyOn(Agent.prototype, "run")
        .mockImplementation(async function* () {
          await Promise.resolve();
          yield { type: "loop_complete", stopReason: "end_turn" };
        });
      try {
        invokePrivate(server, "handleSteeringMessage", ["repeated"]);
        if (status === "delivered") {
          invokePrivate(server, "bridgeEvent", [
            { type: "steering_delivered", text: "repeated" },
            Date.now(),
            () => undefined,
          ]);
        } else {
          invokePrivate(server, "cancelActiveRun");
        }
        historyMod.recordInput({
          text: "another prompt",
          cwd,
          sessionId: null,
          source: "ws",
        });
        await invokePrivateAsync(server, "handleUserMessage", ["repeated"]);
        expect(historyMod.loadInputTexts()).toEqual([
          "repeated",
          "another prompt",
          "repeated",
        ]);
      } finally {
        steer.mockRestore();
        run.mockRestore();
        await server.stop();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it("queues busy Bash submissions instead of steering them into the model", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-busy-bash-"));
    const { server, handle } = await setup(cwd);
    const steer = vi.spyOn(handle, "steer").mockReturnValue(true);
    try {
      invokePrivate(server, "handleSteeringMessage", ["!!echo local-only"]);
      expect(steer).not.toHaveBeenCalled();
      expect(Reflect.get(server, "followUps")).toEqual([
        { text: "!!echo local-only", input: undefined },
      ]);
    } finally {
      steer.mockRestore();
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("serializes provider changes with user turns", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-provider-busy-"));
    const { server, broadcasts } = await setup(cwd);
    let finish: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const change = vi.fn(() => waiting);
    const competingChange = vi.fn();
    try {
      const pending = invokePrivateAsync(
        server,
        "changeProviderConfiguration",
        [change],
      );
      expect(Reflect.get(server, "streaming")).toBe(true);
      await invokePrivateAsync(server, "changeProviderConfiguration", [
        competingChange,
      ]);
      expect(competingChange).not.toHaveBeenCalled();
      invokePrivate(server, "handleSteeringMessage", ["!echo after-switch"]);
      finish();
      await pending;
      expect(Reflect.get(server, "streaming")).toBe(false);
      expect(
        broadcasts.some(
          (message) =>
            message.type === "tool_result" &&
            OutputData.parse(message.data).output.includes("after-switch"),
        ),
      ).toBe(true);
    } finally {
      finish();
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("drops pending follow-ups when the server stops", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-stop-queue-"));
    const { server, broadcasts } = await setup(cwd);
    try {
      invokePrivate(server, "enqueueFollowUp", ["/status"]);
      await server.stop();
      broadcasts.length = 0;
      await invokePrivateAsync(server, "drainFollowUps");
      expect(Reflect.get(server, "followUps")).toEqual([]);
      expect(broadcasts).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("stores uploaded images for @-attachment", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-image-"));
    const { server, broadcasts } = await setup(cwd);
    const replies: Broadcast[] = [];
    const reply = (message: Broadcast) => {
      replies.push(message);
    };
    // 1x1 transparent PNG.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    try {
      await invokePrivateAsync(server, "handleImageUpload", [
        {
          clientId: "c1",
          name: "shot.png",
          dataBase64: png.toString("base64"),
        },
        reply,
      ]);
      const saved = replies.find((message) => message.type === "image_saved");
      const path = PathData.parse(saved?.data).path;
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path).equals(png)).toBe(true);

      const fixedTime = vi.spyOn(Date, "now").mockReturnValue(Date.now());
      try {
        await Promise.all(
          ["same1", "same2"].map((clientId) =>
            invokePrivateAsync(server, "handleImageUpload", [
              {
                clientId,
                name: "same.png",
                dataBase64: png.toString("base64"),
              },
              reply,
            ]),
          ),
        );
        const paths = replies
          .filter((message) => message.type === "image_saved")
          .map((message) => PathData.parse(message.data).path);
        expect(new Set(paths).size).toBe(3);
      } finally {
        fixedTime.mockRestore();
      }

      await invokePrivateAsync(server, "handleImageUpload", [
        { clientId: "c2", name: "bad.png", dataBase64: "aGVsbG8=" },
        reply,
      ]);
      const failed = replies.find((message) => message.type === "image_error");
      expect(ClientIdData.parse(failed?.data).clientId).toBe("c2");
      expect(
        broadcasts.some((message) => message.type.startsWith("image_")),
      ).toBe(false);
    } finally {
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("answers @-mention completion requests from the workspace scan", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-complete-"));
    writeFileSync(join(cwd, "alpha.txt"), "a");
    writeFileSync(join(cwd, "beta.txt"), "b");
    const server = new RemoteServer({
      providers: [provider],
      addr: ":18888",
      enableCoordinatorMode: false,
      forkDisabled: true,
      memoryEnabled: false,
    });
    const handle = await createRemoteAgent({
      provider,
      cwd,
      enableCoordinatorMode: false,
      forkDisabled: true,
      memoryEnabled: false,
    });
    Reflect.set(server, "agentHandle", handle);
    const sent: Broadcast[] = [];
    Reflect.set(server, "send", (_ws: unknown, message: Broadcast) => {
      sent.push(message);
    });
    try {
      invokePrivate(server, "sendFileCompletions", [null, "req-1", "alp"]);
      const response = z
        .object({ requestId: z.string(), matches: z.array(z.string()) })
        .parse(sent[0]?.data);
      expect(response).toEqual({ requestId: "req-1", matches: ["alpha.txt"] });
    } finally {
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("serves the browser protocol end to end over WebSocket", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-ws-"));
    writeFileSync(join(cwd, "smoke.txt"), "content");
    // The server serves the process working directory; point it at the fixture.
    const originalCwd = process.cwd();
    process.chdir(cwd);
    const writes: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
    const server = new RemoteServer({
      providers: [provider],
      addr: "127.0.0.1:0",
      enableCoordinatorMode: false,
      forkDisabled: true,
      memoryEnabled: false,
    });
    const runPromise = server.run();
    let socket: WebSocket | null = null;
    try {
      await vi.waitFor(() => {
        expect(
          writes.some((line) => line.includes("Remote server listening at")),
        ).toBe(true);
      });
      const line =
        writes.find((entry) => entry.includes("Remote server listening at")) ??
        "";
      const browserUrl = new URL(
        /http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+/.exec(line)?.[0] ??
          "",
      );
      const token = new URLSearchParams(browserUrl.hash.slice(1)).get("token");
      const wsUrl = `ws://${browserUrl.host}/ws?token=${encodeURIComponent(token ?? "")}`;
      socket = new WebSocket(wsUrl, {
        headers: { Origin: `http://${browserUrl.host}` },
      });
      const received: Broadcast[] = [];
      const frameSchema = z.object({ type: z.string(), data: z.unknown() });
      socket.on("message", (data: Buffer) => {
        const parsed: unknown = JSON.parse(data.toString("utf-8"));
        received.push(frameSchema.parse(parsed));
      });
      await vi.waitFor(() => {
        expect(socket?.readyState).toBe(WebSocket.OPEN);
      });
      const send = (message: unknown) => {
        socket?.send(JSON.stringify(message));
      };

      // Connection handshake: connected + commands + history arrive.
      await vi.waitFor(() => {
        expect(received.some((m) => m.type === "connected")).toBe(true);
        expect(received.some((m) => m.type === "commands")).toBe(true);
        expect(received.some((m) => m.type === "history")).toBe(true);
      });
      const status = received.find((m) => m.type === "status");
      const statusData = z
        .object({
          model: z.string(),
          provider: z.string(),
          permissionMode: z.string(),
          thinkingLevel: z.string(),
          thinkingLevels: z.array(z.string()),
          sandboxEnabled: z.boolean(),
          sandboxAutoAllow: z.boolean(),
          contextWindow: z.number(),
        })
        .parse(status?.data);
      expect(statusData.model).toBe("test-model");
      expect(statusData.thinkingLevels.length).toBeGreaterThan(0);

      // /status renders the rich terminal-parity output.
      send({ type: "user_message", data: { content: "/status" } });
      await vi.waitFor(() => {
        expect(
          received.some(
            (m) =>
              m.type === "system" &&
              MessageData.parse(m.data).message.includes("Directory:"),
          ),
        ).toBe(true);
      });

      // Permission mode cycling broadcasts the new status.
      send({
        type: "set_permission_mode",
        data: { mode: "acceptEdits" },
      });
      await vi.waitFor(() => {
        expect(
          received.some(
            (m) =>
              m.type === "status" &&
              ModelData.parse(m.data).model === "test-model" &&
              z.object({ permissionMode: z.string() }).parse(m.data)
                .permissionMode === "acceptEdits",
          ),
        ).toBe(true);
      });
      send({ type: "set_permission_mode", data: { mode: "default" } });

      // @-mention completion answers from the workspace scan.
      send({
        type: "file_complete_request",
        data: { requestId: "r1", query: "smoke" },
      });
      await vi.waitFor(() => {
        expect(
          received.some(
            (m) =>
              m.type === "file_complete_response" &&
              z
                .object({ requestId: z.string(), matches: z.array(z.string()) })
                .parse(m.data)
                .matches.includes("smoke.txt"),
          ),
        ).toBe(true);
      });

      // User bash runs and streams a tool card.
      send({ type: "user_message", data: { content: "!echo ws-smoke-ok" } });
      await vi.waitFor(() => {
        expect(
          received.some(
            (m) =>
              m.type === "tool_result" &&
              OutputData.parse(m.data).output.includes("ws-smoke-ok"),
          ),
        ).toBe(true);
      });

      // Image upload round-trips to a saved file path.
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );
      send({
        type: "image_upload",
        data: {
          clientId: "ws-1",
          name: "p.png",
          dataBase64: png.toString("base64"),
        },
      });
      await vi.waitFor(() => {
        expect(received.some((m) => m.type === "image_saved")).toBe(true);
      });

      // Provider list arrives without leaking API keys.
      send({ type: "provider_list_request", data: {} });
      await vi.waitFor(() => {
        expect(received.some((m) => m.type === "provider_list")).toBe(true);
      });
      const providerList = received.find((m) => m.type === "provider_list");
      expect(JSON.stringify(providerList?.data)).not.toContain("api_key");
    } finally {
      socket?.close();
      await server.stop();
      await runPromise;
      stderrSpy.mockRestore();
      process.chdir(originalCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("tracks subagent activity events into broadcast snapshots", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-subagent-"));
    const { server, broadcasts } = await setup(cwd);
    try {
      invokePrivate(server, "handleSubagentEvent", [
        {
          toolCallId: "call-1",
          role: "explorer",
          background: false,
          type: "started",
        },
      ]);
      invokePrivate(server, "handleSubagentEvent", [
        {
          toolCallId: "call-1",
          role: "explorer",
          background: false,
          type: "tool_use",
          toolId: "t1",
          toolName: "Read",
        },
      ]);
      invokePrivate(server, "handleSubagentEvent", [
        {
          toolCallId: "call-1",
          role: "explorer",
          background: false,
          type: "turn_complete",
        },
      ]);
      invokePrivate(server, "handleSubagentEvent", [
        {
          toolCallId: "call-1",
          role: "explorer",
          background: false,
          type: "finished",
          status: "completed",
        },
      ]);
      const last = broadcasts.findLast(
        (message) => message.type === "subagents",
      );
      expect(ListData.parse(last?.data).list).toEqual([
        {
          toolCallId: "call-1",
          role: "explorer",
          background: false,
          turnCount: 1,
          activeTools: [],
          status: "completed",
        },
      ]);
    } finally {
      await server.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
