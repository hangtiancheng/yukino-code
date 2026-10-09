import { render, type Instance } from "ink";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VirtualTerminal } from "./helpers/virtual-terminal.js";

import type { ConversationManager } from "@/conversation/index.js";
import { load as loadPromptHistory } from "@/history/index.js";
import type { LLMClient } from "@/llm/client.js";
import type { StreamEvent } from "@/llm/events.js";
import { App } from "@/ui/app.js";
import { installTerminalOutput } from "@/ui/terminal-output.js";
import { checkForUpdate } from "@/update/version-check.js";
import { contentToText } from "@/utils/index.js";
import { connectToIde } from "@/vscode/ide-client.js";

const { createClientMock } = vi.hoisted(() => ({
  createClientMock: vi.fn<() => Promise<LLMClient>>(),
}));
vi.mock("@/llm/client.js", () => ({ createClient: createClientMock }));
vi.mock("@/update/version-check.js", () => ({ checkForUpdate: vi.fn() }));
vi.mock("@/vscode/ide-client.js", () => ({ connectToIde: vi.fn() }));

class ControlledClient implements LLMClient {
  readonly protocol = "openai";
  readonly requests: {
    users: string[];
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

async function start() {
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
        mcpServers: [],
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
