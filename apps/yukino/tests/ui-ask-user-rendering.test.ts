import { Box, Text, render, type Instance } from "ink";
import { act, createElement, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VirtualTerminal } from "./helpers/virtual-terminal.js";

import type { AgentEvent } from "@/agent/events.js";
import { AskUserQuestionTool, type Question } from "@/tools/ask-user.js";
import { AgentActivity } from "@/ui/agent-activity.js";
import { AskUserDialog } from "@/ui/ask-user-dialog.js";
import { ChatView, type ChatMessage } from "@/ui/chat.js";
import { InputBox } from "@/ui/input.js";
import { TerminalLayout } from "@/ui/terminal-layout.js";
import { installTerminalOutput } from "@/ui/terminal-output.js";
import { Transcript } from "@/ui/transcript.js";
import { useAgentOutput } from "@/ui/use-agent-output.js";

let terminal: VirtualTerminal;
let instance: Instance | undefined;
let restoreOutput: () => void;
let current:
  | {
      output: ReturnType<typeof useAgentOutput>;
      ask: (questions: Question[]) => Promise<Record<string, string>>;
    }
  | undefined;

function Scene() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", content: "BEFORE_QUESTION" },
  ]);
  const [request, setRequest] = useState<{
    questions: Question[];
    resolve: (answers: Record<string, string>) => void;
  } | null>(null);
  const output = useAgentOutput(setMessages);
  current = {
    output,
    ask: (questions) =>
      new Promise((resolve) => {
        setRequest({ questions, resolve });
      }),
  };
  return createElement(TerminalLayout, {
    transcript: createElement(Transcript, {
      messages,
      sessionId: "ask-user-test",
      expanded: false,
      model: "test-model",
      provider: "test-provider",
      cwd: "/workspace",
    }),
    activity: createElement(
      Box,
      { flexDirection: "column" },
      createElement(ChatView, {
        streamingText: output.streamingText,
        thinkingText: output.streamingThinking,
      }),
      createElement(AgentActivity, {
        tools: output.activeTools,
        subagents: [],
        backgroundTasks: [],
        teammates: [],
        isAsking: request !== null,
        expanded: false,
      }),
    ),
    status: null,
    dock: request
      ? createElement(AskUserDialog, {
          questions: request.questions,
          onComplete: (answers) => {
            request.resolve(answers);
            setRequest(null);
          },
        })
      : createElement(InputBox, {
          onSubmit: vi.fn(),
          statusLabel: "Working",
          inputState: "agent",
        }),
    footer: createElement(Text, {}, "/workspace"),
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("TERM_PROGRAM", "vscode");
  vi.stubEnv("TMUX", "");
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
  current = undefined;
  restoreOutput();
  terminal.dispose();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    await instance?.waitUntilRenderFlush();
    await terminal.flush();
  });
}

describe("answered question rendering", () => {
  it.each([
    { rows: 24, duringCommit: false },
    { rows: 24, duringCommit: true },
    { rows: 12, duringCommit: false },
    { rows: 12, duringCommit: true },
    { rows: 24, duringCommit: false, pending: true },
    { rows: 24, duringCommit: true, pending: true },
    { rows: 12, duringCommit: true, pending: true },
    { rows: 24, duringCommit: true, pending: true, questionCount: 4 },
  ])(
    "keeps answered questions across shrinking with %j",
    async ({ rows, duringCommit, pending, questionCount = 1 }) => {
      terminal.resize(120, rows);
      act(() => {
        instance = render(createElement(Scene), {
          stdout: terminal.stdout,
          stdin: terminal.stdin,
          stderr: terminal.stdout,
          interactive: true,
          patchConsole: false,
          exitOnCtrlC: false,
        });
      });
      await flush();
      if (!current) {
        throw new Error("Scene is not mounted");
      }
      let handler: ((event: AgentEvent) => void) | undefined;
      act(() => {
        handler = current?.output.createEventHandler();
      });
      const detail =
        questionCount > 1 ? "使用项目配置和环境变量 ".repeat(10) : "";
      const questions: Question[] = Array.from(
        { length: questionCount },
        (_, index) => ({
          header: `Database ${String(index + 1)}`,
          question: `QUESTION_${String(index)} 哪一种数据库配置适合这个项目? ${detail}`,
          options: [
            {
              label: `ANSWER_${String(index)} 使用环境变量中的连接配置 ${detail}`,
            },
            { label: "Use defaults" },
          ],
          multiSelect: false,
        }),
      );
      const tool = new AskUserQuestionTool(current.ask);
      let result: ReturnType<typeof tool.execute> | undefined;
      await act(async () => {
        handler?.({
          type: "tool_use",
          toolName: tool.name,
          toolId: "question",
          args: { questions },
        });
        if (pending) {
          handler?.({
            type: "tool_use",
            toolName: "ReadFile",
            toolId: "parallel",
            args: { file_path: "diagnostics.log" },
          });
        }
        result = tool.execute({ cwd: "/workspace" }, { questions });
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
      await flush();
      for (let index = 0; index < questionCount; index++) {
        await act(async () => {
          terminal.inputStream.write("1");
          await new Promise<void>((resolve) => setImmediate(resolve));
        });
        await flush();
      }
      if (questionCount > 1) {
        await act(async () => {
          terminal.inputStream.write("\r");
          await new Promise<void>((resolve) => setImmediate(resolve));
        });
      }
      const answer = await result;
      if (!answer) {
        throw new Error("Question did not complete");
      }
      act(() => {
        handler?.({
          type: "tool_result",
          toolName: tool.name,
          toolId: "question",
          ...answer,
          elapsed: 1,
        });
        if (pending) {
          handler?.({
            type: "tool_result",
            toolName: "ReadFile",
            toolId: "parallel",
            output: ("Diagnostics output ".repeat(5) + "\n").repeat(5),
            isError: false,
            elapsed: 1,
          });
        }
        if (duringCommit) {
          terminal.resize(48, rows);
        }
      });
      await flush();
      act(() => {
        if (!pending) {
          handler?.({ type: "turn_complete" });
        }
      });
      await flush();
      for (const columns of [48, 32, 120, 40, 96]) {
        act(() => {
          terminal.resize(columns, rows);
        });
        await flush();
        const lines = terminal.bufferLines();
        const text = lines.join("").replaceAll(/\s/gu, "");
        for (const marker of [
          "BEFORE_QUESTION",
          "AskUserQuestion",
          ...questions.flatMap((_, index) => [
            `QUESTION_${String(index)}`,
            `ANSWER_${String(index)}`,
          ]),
        ]) {
          expect(
            text.split(marker).length - 1,
            JSON.stringify({ columns, lines: lines.slice(-40) }),
          ).toBe(1);
        }
        for (const question of questions) {
          expect(text).toContain(question.question.replaceAll(/\s/gu, ""));
          expect(text).toContain(
            question.options[0].label.replaceAll(/\s/gu, ""),
          );
        }
      }
      act(() => {
        handler?.({ type: "turn_complete" });
        handler?.({ type: "loop_complete", stopReason: "end_turn" });
      });
      await flush();
      expect(
        terminal.bufferLines().join("").split("AskUserQuestion"),
      ).toHaveLength(2);
    },
  );
});
