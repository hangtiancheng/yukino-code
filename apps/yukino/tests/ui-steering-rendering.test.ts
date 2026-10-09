import { Box, Text, render } from "ink";
import type { Instance } from "ink";
import { act, createElement, useState } from "react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VirtualTerminal } from "./helpers/virtual-terminal.js";

import { ChatView, type ChatMessage } from "@/ui/chat.js";
import { InputBox } from "@/ui/input.js";
import { PendingQueue } from "@/ui/pending-queue.js";
import { setThemeMode, THEME } from "@/ui/styles.js";
import { TerminalLayout } from "@/ui/terminal-layout.js";
import { installTerminalOutput } from "@/ui/terminal-output.js";
import { TodoProgress } from "@/ui/todo-progress.js";
import { Transcript } from "@/ui/transcript.js";

let terminal: VirtualTerminal;
let instance: Instance | undefined;
let restoreOutput: () => void;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("TERM_PROGRAM", "vscode");
  vi.stubEnv("TMUX", "");
  setThemeMode("light");
  terminal = new VirtualTerminal(120, 24);
  restoreOutput = installTerminalOutput(terminal.stdout);
});

afterEach(async () => {
  await act(async () => {
    const exit = instance?.waitUntilExit();
    instance?.unmount();
    await exit;
    instance?.cleanup();
  });
  instance = undefined;
  restoreOutput();
  terminal.dispose();
  setThemeMode("dark");
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function Scene({
  messages = [],
  steering = [],
  followUps = [],
  text = "",
  onSubmit = vi.fn(),
}: {
  messages?: ChatMessage[];
  steering?: string[];
  followUps?: string[];
  text?: string;
  onSubmit?: (text: string) => void;
}) {
  return createElement(TerminalLayout, {
    transcript: createElement(Transcript, {
      messages,
      sessionId: "steering-test",
      expanded: false,
      model: "test-model",
      provider: "test-provider",
      cwd: "/workspace",
    }),
    activity: createElement(ChatView, {
      thinkingText: "Checking the implementation",
      streamingText: text,
    }),
    status: createElement(
      Box,
      { flexDirection: "column" },
      createElement(PendingQueue, { messages: followUps, steering }),
      createElement(TodoProgress, {
        tasks: [
          {
            id: "1",
            subject: "检查引用",
            description: "",
            activeForm: "清点引用",
            status: "in_progress",
            metadata: {},
            blockedBy: [],
            blocks: [],
          },
        ],
      }),
    ),
    dock: createElement(InputBox, {
      onSubmit,
      statusLabel: "Working",
      inputState: "agent",
    }),
    footer: createElement(Text, {}, "/workspace"),
  });
}

function SubmissionScene() {
  const [steering, setSteering] = useState<string[]>([]);
  return createElement(Scene, {
    steering,
    onSubmit: (message) => {
      setSteering((pending) => [...pending, message]);
    },
  });
}

async function showElement(scene: ReactNode) {
  act(() => {
    if (instance) {
      instance.rerender(scene);
    } else {
      instance = render(scene, {
        stdout: terminal.stdout,
        stdin: terminal.stdin,
        stderr: terminal.stdout,
        interactive: true,
        patchConsole: false,
        exitOnCtrlC: false,
      });
    }
  });
  await instance?.waitUntilRenderFlush();
  await terminal.flush();
}

async function show(props: Parameters<typeof Scene>[0]) {
  await showElement(createElement(Scene, props));
}

describe("steering message rendering", () => {
  it.each([11, 12, 24, 40])(
    "keeps queued steering visible beside TODO status at %i rows after the editor clears",
    async (rows) => {
      terminal.resize(120, rows);
      await showElement(createElement(SubmissionScene));
      await act(async () => {
        terminal.inputStream.write("所有的 go mod 都应该遵循 go 项目最佳实践");
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
      await instance?.waitUntilRenderFlush();
      await act(async () => {
        terminal.inputStream.write("\r");
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
      await instance?.waitUntilRenderFlush();
      await terminal.flush();

      const screen = terminal
        .bufferLines()
        .slice(terminal.terminal.buffer.active.baseY)
        .join("\n");
      expect(screen).toContain(
        "Steering: 所有的 go mod 都应该遵循 go 项目最佳实践",
      );
      expect(screen).toContain("TODO 0/1");
      expect(screen).toContain("Working");
      expect(
        screen.match(/所有的 go mod 都应该遵循 go 项目最佳实践/gu),
      ).toHaveLength(1);
    },
  );

  it("shares the queue budget between steering and follow-ups while the live output fills the screen", async () => {
    await show({
      steering: ["STEER_1", "STEER_2", "STEER_3", "STEER_4"],
      followUps: ["FOLLOW_UP_1", "FOLLOW_UP_2"],
      text: "Working on the configuration\n\n".repeat(30),
    });
    const screen = terminal
      .bufferLines()
      .slice(terminal.terminal.buffer.active.baseY)
      .join("\n");
    expect(screen).toContain("Steering: STEER_3");
    expect(screen).toContain("Steering: STEER_4");
    expect(screen).toContain("Follow-up: FOLLOW_UP_2");
    expect(screen).toContain("6 queued messages");
    expect(screen).toContain("TODO 0/1");
    expect(screen).toContain("Working");
    expect(terminal.terminal.buffer.active.baseY).toBeGreaterThan(0);
  });

  it.each([
    { batched: false, tall: false, rows: 24 },
    { batched: true, tall: false, rows: 24 },
    { batched: false, tall: true, rows: 24 },
    { batched: true, tall: true, rows: 24 },
    { batched: true, tall: false, rows: 5 },
    { batched: true, tall: true, rows: 12 },
  ])(
    "prints both delivered steering cards completely with batched=$batched tall=$tall rows=$rows",
    async ({ batched, tall, rows }) => {
      terminal.resize(120, rows);
      const first = "FIRST_STEER 本项目使用半角标点";
      const second =
        "SECOND_STEER '/workspace/.env' 你继续完善\n\nSECOND_END 必要的环境变量已经补充";
      const messages: ChatMessage[] = Array.from({ length: 80 }, (_, row) => ({
        role: "assistant",
        content: `HISTORY_${String(row)}`,
      }));
      const text = tall ? "Working on the configuration\n\n".repeat(30) : "";
      await show({
        messages: messages.slice(),
        steering: [first, second],
        text,
      });
      messages.push({ role: "user", content: first });
      if (!batched) {
        await show({ messages: messages.slice(), steering: [second], text });
      }
      messages.push(
        { role: "user", content: second },
        {
          role: "turn_summary",
          content: "Reviewing the configuration",
          thinkingDuration: 56.5,
          toolSummary: [
            {
              toolName: "ReadFile",
              argsSummary: "config.yml",
              output: Array.from(
                { length: 20 },
                (_, row) => `CONFIG_ROW_${String(row)}`,
              ).join("\n"),
              isError: false,
              elapsed: 0.1,
            },
          ],
        },
      );
      await show({ messages });
      await show({ messages, text: "Continuing with the requested changes" });

      const lines = terminal.bufferLines();
      for (const marker of ["FIRST_STEER", "SECOND_STEER", "SECOND_END"]) {
        expect(lines.filter((line) => line.includes(marker))).toHaveLength(1);
      }
      const color = Number.parseInt(THEME.userMessageBg.slice(1), 16);
      const coloredRows = lines.filter(
        (_, row) =>
          terminal.terminal.buffer.active
            .getLine(row)
            ?.getCell(0)
            ?.getBgColor() === color,
      );
      expect(coloredRows).toHaveLength(8);
    },
  );
});
