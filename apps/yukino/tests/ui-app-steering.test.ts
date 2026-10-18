import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { render, type Instance } from "ink";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VirtualTerminal } from "./helpers/virtual-terminal.js";

import * as config from "@/config/index.js";
import type { MCPServerConfig } from "@/config/index.js";
import type { ConversationManager } from "@/conversation/index.js";
import { runFeedbackPipeline } from "@/feedback/pipeline.js";
import type { PipelineDeps, PipelineResult } from "@/feedback/pipeline.js";
import type { FeedbackOptions } from "@/feedback/types.js";
import { load as loadPromptHistory } from "@/history/index.js";
import type { LLMClient } from "@/llm/client.js";
import type { StreamEvent } from "@/llm/events.js";
import { MCPClient } from "@/mcp/client.js";
import { PermissionChecker } from "@/permissions/index.js";
import * as sessionMod from "@/session/index.js";
import { FileStateCache } from "@/tools/file-state-cache.js";
import { App } from "@/ui/app.js";
import { installTerminalOutput } from "@/ui/terminal-output.js";
import { checkForUpdate } from "@/update/version-check.js";
import { contentToText } from "@/utils/index.js";
import { connectToIde } from "@/vscode/ide-client.js";

const { createClientMock, feedbackMock } = vi.hoisted(() => ({
  createClientMock: vi.fn<() => Promise<LLMClient>>(),
  feedbackMock:
    vi.fn<
      (options: FeedbackOptions, deps: PipelineDeps) => Promise<PipelineResult>
    >(),
}));
vi.mock("@/llm/client.js", () => ({ createClient: createClientMock }));
vi.mock("@/feedback/pipeline.js", () => ({
  runFeedbackPipeline: feedbackMock,
}));
vi.mock("@/update/version-check.js", () => ({ checkForUpdate: vi.fn() }));
vi.mock("@/vscode/ide-client.js", () => ({ connectToIde: vi.fn() }));

class ControlledClient implements LLMClient {
  readonly protocol = "openai";
  readonly requests: {
    users: string[];
    conversation: ConversationManager;
    messages: ReturnType<ConversationManager["getMessages"]>;
    schemas: unknown[];
    signal?: AbortSignal;
    finish: () => void;
  }[] = [];

  setSystemPrompt = vi.fn<(prompt: string) => void>();

  async *stream(
    conversation: ConversationManager,
    _schemas: unknown[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    let finish = (): void => undefined;
    const waiting = new Promise<void>((resolve, reject) => {
      const abort = () => {
        reject(new DOMException("Interrupted", "AbortError"));
      };
      finish = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
      }
    });
    const index = this.requests.length;
    this.requests.push({
      conversation,
      messages: structuredClone(conversation.getMessages()),
      schemas: structuredClone(_schemas),
      users: conversation
        .getMessages()
        .filter((message) => message.role === "user")
        .map((message) => contentToText(message.content)),
      signal,
      finish,
    });
    yield {
      type: "text_delta",
      text:
        index === 0
          ? "FIRST_REPLY\n\n" +
            "Prior assistant output\n".repeat(60) +
            "FIRST_END"
          : `NEXT_REPLY_${String(index)}`,
    };
    await waiting;
    yield {
      type: "stream_end",
      stopReason: "end_turn",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    };
  }
}

let terminal: VirtualTerminal;
let instance: Instance | undefined;
let restoreOutput: () => void;
let client: ControlledClient;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("TERM_PROGRAM", "vscode");
  vi.stubEnv("TMUX", "");
  client = new ControlledClient();
  createClientMock.mockResolvedValue(client);
  vi.mocked(checkForUpdate).mockResolvedValue(undefined);
  vi.mocked(connectToIde).mockResolvedValue(null);
  terminal = new VirtualTerminal(120, 24);
  restoreOutput = installTerminalOutput(terminal.stdout);
});

afterEach(async () => {
  await act(async () => {
    const exit = instance?.waitUntilExit();
    instance?.unmount();
    await exit;
    instance?.cleanup();
    for (const request of client.requests) {
      request.finish();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  instance = undefined;
  restoreOutput();
  terminal.dispose();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function flush() {
  await instance?.waitUntilRenderFlush();
  await terminal.flush();
}

async function waitForRequests(count: number) {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    expect(client.requests).toHaveLength(count);
  });
  await flush();
}

async function finishRequest(index: number) {
  await act(async () => {
    client.requests[index]?.finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await flush();
}

async function press(input: string) {
  await act(async () => {
    terminal.inputStream.write(input);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await flush();
}

async function submit(text: string) {
  await press(text);
  await press("\r");
}

async function start(mcpServers: MCPServerConfig[] = []) {
  await act(async () => {
    instance = render(
      createElement(App, {
        providers: [
          {
            name: "test",
            protocol: "openai",
            base_url: "http://unused.example",
            model: "test-model",
          },
        ],
        mcpServers,
        hooks: [],
        memoryEnabled: false,
      }),
      {
        stdout: terminal.stdout,
        stdin: terminal.stdin,
        stderr: terminal.stdout,
        interactive: true,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await flush();
  await submit("INITIAL_REQUEST");
  await waitForRequests(1);
}

describe("App steering delivery", () => {
  it("keeps the read cache when the rewind picker is cancelled", async () => {
    await start();
    await finishRequest(0);
    const clear = vi.spyOn(FileStateCache.prototype, "clear");
    const conversation = client.requests[0].conversation;
    const before = conversation.getMessages();
    await submit("/rewind ");
    await press("\r");
    await press("\x1b[A");
    await press("\r");
    expect(clear).not.toHaveBeenCalled();
    expect(conversation.getMessages()).toEqual(before);
  });

  it("keeps queued input and history after a conversation rewind fails", async () => {
    await start();
    await submit("/rewind ");
    await submit("/queued-after-rewind-failure");
    await finishRequest(0);
    const clear = vi.spyOn(FileStateCache.prototype, "clear");
    vi.spyOn(sessionMod, "truncateSessionLines").mockImplementation(() => {
      throw new Error("rewind storage unavailable");
    });
    const conversation = client.requests[0].conversation;
    const before = conversation.getMessages();
    await press("\r");
    await press("\x1b[B");
    await press("\r");
    await vi.waitFor(async () => {
      await act(async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await flush();
      });
      expect(terminal.bufferLines().join("\n")).toContain(
        "Unknown command: /queued-after-rewind-failure",
      );
    });
    expect(clear).not.toHaveBeenCalled();
    expect(conversation.getMessages()).toEqual(before);
    expect(terminal.bufferLines().join("\n")).toContain(
      "Rewind failed: rewind storage unavailable",
    );
  });

  it("keeps the original session and queued input if resume cannot touch its transcript", async () => {
    await start();
    const targetId = sessionMod.newSessionId();
    sessionMod.saveMessage(process.cwd(), targetId, {
      role: "user",
      content: "RESUME_TARGET",
      timestamp: 1,
    });
    vi.spyOn(sessionMod, "touchSession").mockImplementation(() => {
      throw new Error("resume storage unavailable");
    });
    await submit(`/resume ${targetId}`);
    await submit("/queued-after-resume-failure");
    await finishRequest(0);
    await vi.waitFor(async () => {
      await act(async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await flush();
      });
      expect(terminal.bufferLines().join("\n")).toContain(
        "Unknown command: /queued-after-resume-failure",
      );
    });
    const text = client.requests[0].conversation
      .getMessages()
      .map((message) => contentToText(message.content))
      .join("\n");
    expect(text).toContain("INITIAL_REQUEST");
    expect(text).not.toContain("RESUME_TARGET");
  });
  it.each([5, 12, 24, 40])(
    "renders delivered steering cards after the prior assistant response at %i rows",
    async (rows) => {
      terminal.resize(120, rows);
      await start();
      await submit("STEERING_CARD 中文修正");
      await submit("SECOND_STEERING_CARD");
      await finishRequest(0);
      await waitForRequests(2);
      expect(client.requests[1]?.users.slice(-2)).toEqual([
        "STEERING_CARD 中文修正",
        "SECOND_STEERING_CARD",
      ]);
      await finishRequest(1);
      const lines = terminal.bufferLines();
      expect(
        lines.filter((line) => line.includes("STEERING_CARD 中文修正")),
      ).toHaveLength(1);
      expect(
        lines.filter((line) => line.includes("SECOND_STEERING_CARD")),
      ).toHaveLength(1);
      const first = lines.findIndex((line) =>
        line.includes("STEERING_CARD 中文修正"),
      );
      const second = lines.findIndex((line) =>
        line.includes("SECOND_STEERING_CARD"),
      );
      expect(first).toBeGreaterThan(
        lines.findIndex((line) => line.includes("FIRST_END")),
      );
      expect(second).toBeGreaterThan(first);
      expect(
        lines.findIndex((line) => line.includes("NEXT_REPLY_1")),
      ).toBeGreaterThan(second);
    },
  );

  it.each(["\x1b", "\x03"])(
    "continues queued steering after interrupt %j with a fresh signal",
    async (interrupt) => {
      await start();
      await submit("STEERING_AFTER_INTERRUPT");
      await press(interrupt);
      await waitForRequests(2);
      expect(client.requests[0]?.signal?.aborted).toBe(true);
      expect(client.requests[1]?.signal?.aborted).toBe(false);
      expect(
        client.requests[1]?.users.filter(
          (text) => text === "STEERING_AFTER_INTERRUPT",
        ),
      ).toHaveLength(1);
      await finishRequest(1);
      expect(
        terminal
          .bufferLines()
          .filter((line) => line.includes("STEERING_AFTER_INTERRUPT")),
      ).toHaveLength(1);
    },
  );

  it("preserves duplicate steering messages and their order across interruption", async () => {
    await start();
    for (const text of ["REPEAT_STEER", "REPEAT_STEER", "TAIL_STEER"]) {
      await submit(text);
    }
    await press("\x03");
    for (let index = 1; index <= 3; index++) {
      await waitForRequests(index + 1);
      const request = client.requests[index];
      expect(
        request?.users.filter((text) => text === "REPEAT_STEER"),
      ).toHaveLength(Math.min(index, 2));
      expect(request?.users.includes("TAIL_STEER")).toBe(index === 3);
      expect(request?.signal?.aborted).toBe(false);
      await finishRequest(index);
    }
    await flush();
    const lines = terminal.bufferLines();
    expect(lines.filter((line) => line.includes("REPEAT_STEER"))).toHaveLength(
      2,
    );
    expect(lines.filter((line) => line.includes("TAIL_STEER"))).toHaveLength(1);
    expect(loadPromptHistory()).toEqual([
      "INITIAL_REQUEST",
      "REPEAT_STEER",
      "TAIL_STEER",
    ]);
  });

  it("stops without starting another request when no steering is queued", async () => {
    await start();
    await press("\x03");
    await flush();
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]?.signal?.aborted).toBe(true);
    await submit("EXPLICIT_NEXT_REQUEST");
    await waitForRequests(2);
    expect(client.requests[1]?.users).toContain("EXPLICIT_NEXT_REQUEST");
    await finishRequest(1);
  });
});

describe("App feedback approval", () => {
  const issues = [
    {
      title: "[tool] Retry storm",
      body: "## What happened\nCONCRETE_TOOL_FAILURE\n\n## Evidence\nTOOL_EVIDENCE_END",
    },
    { title: "[ui] Lost input", body: "## What happened\nCONCRETE_UI_FAILURE" },
  ];
  const filed = vi.fn();

  beforeEach(() => {
    feedbackMock.mockReset();
    filed.mockReset();
    feedbackMock.mockImplementation(async (_options, deps) => {
      const confirmation = await deps.confirmIssues(issues);
      deps.abortSignal.throwIfAborted();
      if (confirmation.approved) {
        filed(issues);
        return { report: "Feedback issues filed." };
      }
      return {
        report: "Feedback rejected.",
        rejection: { issues, reason: confirmation.reason },
      };
    });
  });

  async function openFeedback() {
    await start();
    await finishRequest(0);
    await submit("/feedback observed failures");
    await press(" ");
    await press("\r");
    await vi.waitFor(() => {
      expect(runFeedbackPipeline).toHaveBeenCalledTimes(1);
    });
    await flush();
    expect(filed).not.toHaveBeenCalled();
  }

  it.each([8, 24])(
    "shows all drafts and requires approval at %i rows",
    async (rows) => {
      terminal.resize(120, rows);
      await openFeedback();
      expect(feedbackMock.mock.calls[0][0].attachments).toEqual([
        "tools",
        "file-history",
        "log",
        "env",
      ]);
      expect(terminal.bufferLines().join("\n")).toContain("TOOL_EVIDENCE_END");
      expect(terminal.bufferLines().join("\n")).toContain(
        "CONCRETE_UI_FAILURE",
      );
      await press("\r");
      await vi.waitFor(() => {
        expect(filed).toHaveBeenCalledWith(issues);
      });
    },
  );

  it("sends a slash-prefixed rejection reason to the model as feedback", async () => {
    await openFeedback();
    await press("\x1b[B");
    await press("\r");
    await submit("/quit is the text of my rejection reason");
    await waitForRequests(2);
    expect(filed).not.toHaveBeenCalled();
    expect(client.requests[1]?.users.at(-1)).toBe(
      "Feedback on the rejected /feedback issues:\n\n/quit is the text of my rejection reason",
    );
    expect(JSON.stringify(client.requests[1]?.messages)).toContain(
      "feedback_issue_rejection",
    );
    await finishRequest(1);
  });

  it("cancels a pending approval without filing or leaving input blocked", async () => {
    await openFeedback();
    await press("\x03");
    expect(feedbackMock.mock.calls[0][1].abortSignal.aborted).toBe(true);
    expect(filed).not.toHaveBeenCalled();
    await submit("Continue after feedback cancellation");
    await waitForRequests(2);
    await finishRequest(1);
  });
});

describe("App plan approval", () => {
  it.each([
    {
      approval: "manual selection",
      keys: ["\x1b[B", "\r"],
      mode: "default",
      effect: "ask",
      message: "Each edit requires confirmation.",
    },
    {
      approval: "Escape",
      keys: ["\x1b"],
      mode: "default",
      effect: "ask",
      message: "Each edit requires confirmation.",
    },
    {
      approval: "YOLO selection",
      keys: ["\r"],
      mode: "bypassPermissions",
      effect: "allow",
      message: "Entered YOLO mode.",
    },
  ])(
    "uses $mode after $approval for a plan entered with Shift+Tab",
    async ({ keys, mode, effect, message }) => {
      vi.stubEnv("YUKINO_BYPASS_PERMISSIONS", "");
      const entered = vi.spyOn(PermissionChecker.prototype, "enterPlanMode");
      await start();
      await finishRequest(0);
      for (let index = 0; index < 3; index++) {
        await press("\x1b[Z");
      }
      expect(entered).toHaveBeenCalledOnce();
      const checker = entered.mock.contexts[0];
      if (!(checker instanceof PermissionChecker)) {
        throw new Error("Plan mode owner was not captured");
      }
      expect(checker.mode).toBe("plan");
      const plan = "A concrete test plan.";
      vi.spyOn(client, "stream").mockImplementationOnce(async function* () {
        await writeFile(checker.planFilePath, plan);
        yield {
          type: "tool_call_start",
          toolId: "exit-plan",
          toolName: "ExitPlanMode",
        };
        yield {
          type: "tool_call_complete",
          toolId: "exit-plan",
          toolName: "ExitPlanMode",
          arguments: {},
        };
        yield {
          type: "stream_end",
          stopReason: "tool_use",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        };
      });
      await submit("Finish the plan");
      await vi.waitFor(() => {
        expect(terminal.bufferLines().join("\n")).toContain("Plan complete");
      });
      for (const key of keys) {
        await press(key);
      }
      await waitForRequests(2);
      expect(terminal.bufferLines().join("\n")).toContain(message);
      expect(checker.mode).toBe(mode);
      expect(
        checker.check("EditFile", "write", {
          file_path: join(process.cwd(), "plan-approval-test.txt"),
        }).effect,
      ).toBe(effect);
      expect(client.requests[1]?.users.at(-1)).toBe(
        `Execute this plan:\n\n${plan}`,
      );
      await finishRequest(1);
    },
  );
});

describe("App MCP reload", () => {
  it("retracts old instructions without rewriting the cached conversation prefix or unchanged schemas", async () => {
    let changed = false;
    vi.spyOn(MCPClient.prototype, "connect").mockImplementation(function (
      this: MCPClient,
    ) {
      return changed && this.name === "failed"
        ? Promise.reject(new Error("server unavailable"))
        : Promise.resolve();
    });
    vi.spyOn(MCPClient.prototype, "disconnect").mockResolvedValue();
    vi.spyOn(MCPClient.prototype, "listTools").mockResolvedValue([
      {
        name: "echo",
        description: "Echo",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    vi.spyOn(MCPClient.prototype, "getInstructions").mockImplementation(
      function (this: MCPClient) {
        return changed && this.name === "quiet"
          ? ""
          : `${this.name} ${changed ? "new" : "old"} guidance`;
      },
    );
    const servers = ["same", "removed", "failed", "quiet"].map((name) => ({
      name,
      command: "unused",
    }));
    const loadConfig = vi.spyOn(config, "loadConfig").mockReturnValue({
      default_provider: 0,
      providers: [],
      mcp_servers: servers,
      hooks: [],
    });
    vi.spyOn(config, "withProjectMcpServers").mockImplementation(
      (loaded) => loaded,
    );
    await start(servers);
    await finishRequest(0);
    const systemPromptCalls = client.setSystemPrompt.mock.calls.length;
    const conversation = client.requests[0].conversation;
    const before = structuredClone(conversation.getMessages());
    expect(
      before.map((message) => contentToText(message.content)).join("\n"),
    ).toContain("removed old guidance");

    await submit("/mcp reload");
    await vi.waitFor(() => {
      expect(terminal.bufferLines().join("\n")).toContain("MCP reloaded:");
    });
    await submit("AFTER_UNCHANGED_RELOAD");
    await waitForRequests(2);
    const unchanged = client.requests[1];
    expect(unchanged.schemas).toEqual(client.requests[0].schemas);
    expect(unchanged.messages.slice(0, before.length)).toEqual(before);
    const appended = unchanged.messages
      .slice(before.length)
      .map((message) => contentToText(message.content))
      .join("\n");
    expect(appended).toContain(
      "no longer apply:\nfailed\nquiet\nremoved\nsame",
    );
    expect(appended.indexOf("no longer apply")).toBeLessThan(
      appended.indexOf("## same\nsame old guidance"),
    );
    await finishRequest(1);

    changed = true;
    loadConfig.mockReturnValue({
      default_provider: 0,
      providers: [],
      mcp_servers: servers.filter(({ name }) => name !== "removed"),
      hooks: [],
    });
    const prefix = structuredClone(conversation.getMessages());
    await submit("/mcp reload");
    await vi.waitFor(() => {
      expect(terminal.bufferLines().join("\n")).toContain("server unavailable");
    });
    await submit("AFTER_CHANGED_RELOAD");
    await waitForRequests(3);
    const reloaded = client.requests[2].messages;
    expect(reloaded.slice(0, prefix.length)).toEqual(prefix);
    const delta = reloaded
      .slice(prefix.length)
      .map((message) => contentToText(message.content))
      .join("\n");
    expect(delta).toContain("no longer apply:\nfailed\nquiet\nremoved\nsame");
    expect(delta).toContain("## same\nsame new guidance");
    expect(delta).not.toContain("## quiet");
    expect(client.setSystemPrompt).toHaveBeenCalledTimes(systemPromptCalls);
    await finishRequest(2);
  });
});
