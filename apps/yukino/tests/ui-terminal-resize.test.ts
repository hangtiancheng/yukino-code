import type { Terminal } from "@xterm/headless";
import { Box, Text, render } from "ink";
import type { Instance } from "ink";
import { act, createElement, Fragment } from "react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VirtualTerminal } from "./helpers/virtual-terminal.js";

import { AgentStatus } from "@/ui/agent-status.js";
import { ChatView, type ChatMessage } from "@/ui/chat.js";
import { Footer } from "@/ui/footer.js";
import { InputBox } from "@/ui/input.js";
import { setThemeMode, THEME } from "@/ui/styles.js";
import { TerminalLayout } from "@/ui/terminal-layout.js";
import { installTerminalOutput } from "@/ui/terminal-output.js";
import { ToolCard } from "@/ui/tool-display.js";
import { Transcript } from "@/ui/transcript.js";
import { useTerminalDimensions } from "@/ui/use-terminal-layout.js";

let virtualTerminal: VirtualTerminal;
let terminal: Terminal;
let instance: Instance | undefined;
let stdout: NodeJS.WriteStream;
let stdin: NodeJS.ReadStream;
let restoreOutput: () => void;
let output: string[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("TERM_PROGRAM", "vscode");
  vi.stubEnv("TMUX", "");
  setThemeMode("light");
  virtualTerminal = new VirtualTerminal(120, 40);
  ({ terminal, stdout, stdin, output } = virtualTerminal);
  restoreOutput = installTerminalOutput(stdout);
});

afterEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    const exit = instance?.waitUntilExit();
    instance?.unmount();
    await exit;
    instance?.cleanup();
  });
  instance = undefined;
  restoreOutput();
  virtualTerminal.dispose();
  vi.useRealTimers();
  setThemeMode("dark");
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function bufferLines() {
  return virtualTerminal.bufferLines();
}

async function resize(columns: number, rows = 40) {
  terminal.resize(columns, rows);
  const readingPosition = terminal.buffer.active.viewportY;
  act(() => {
    stdout.columns = columns;
    stdout.rows = rows;
    stdout.emit("resize");
  });
  await instance?.waitUntilRenderFlush();
  return readingPosition;
}
function Scene({
  historyRows = 1,
  nativeCursor = true,
  working = false,
  messages,
  activity = null,
}: {
  historyRows?: number;
  nativeCursor?: boolean;
  working?: boolean;
  messages?: ChatMessage[];
  activity?: ReactNode;
}) {
  const { columns } = useTerminalDimensions();
  return createElement(TerminalLayout, {
    transcript: createElement(Transcript, {
      messages:
        messages ??
        Array.from({ length: historyRows }, (_, index) => ({
          role: "assistant" as const,
          content: `saved-${String(index)}`,
        })),
      sessionId: "resize-test",
      expanded: false,
      model: "test-model",
      provider: "test-provider",
      cwd: "/workspace",
    }),
    activity,
    status: createElement(
      Box,
      { width: "100%", justifyContent: "flex-end" },
      createElement(AgentStatus, { teammates: 8, backgroundSubagents: 0 }),
    ),
    dock: nativeCursor
      ? createElement(InputBox, {
          onSubmit: vi.fn(),
          statusLabel: working ? "Working" : undefined,
          inputState: working ? "agent" : "idle",
        })
      : createElement(Text, {}, "─".repeat(columns)),
    footer: createElement(Footer, {
      contextTokens: 40_000,
      contextWindow: 200_000,
      inputTokens: 1250,
      outputTokens: 230,
      model: "test-model",
      thinkingLevel: "high",
      permissionMode: "plan",
      provider: "test-provider",
      sessionId: "1234567890",
      cwd: "/workspace",
    }),
  });
}

function RightEdgeText() {
  const { columns } = useTerminalDimensions();
  return createElement(Text, {}, "EDGE_" + "x".repeat(columns - 7) + "日");
}

describe("terminal resize output", () => {
  it.each(
    ["user", "assistant", "tool"].flatMap((lastCard, index) =>
      [0, 40].map((liveRows) => ({ lastCard, index, liveRows })),
    ),
  )(
    "preserves recent cards with $lastCard last and $liveRows live rows when native height changes coalesce",
    async ({ index, liveRows }) => {
      const recent: ChatMessage[] = [
        { role: "user", content: "LATEST_USER" },
        { role: "assistant", content: "LATEST_ASSISTANT" },
        {
          role: "turn_summary",
          content: "",
          toolSummary: [
            {
              toolName: "ReadFile",
              argsSummary: "LATEST_TOOL",
              output: "LATEST_RESULT",
              isError: false,
              elapsed: 0.1,
            },
          ],
        },
      ];
      const messages: ChatMessage[] = [
        ...Array.from({ length: 60 }, (_, index) => ({
          role: "assistant" as const,
          content: `saved-${String(index)}`,
        })),
        ...recent.slice(index + 1),
        ...recent.slice(0, index + 1),
      ];
      const scene = () =>
        createElement(Scene, {
          messages: messages.slice(),
          activity: liveRows
            ? createElement(Text, {}, "LIVE_ROW\n".repeat(liveRows))
            : null,
        });
      act(() => {
        instance = render(scene(), {
          stdout,
          stdin,
          stderr: stdout,
          interactive: true,
          patchConsole: false,
          exitOnCtrlC: false,
        });
      });
      await instance?.waitUntilRenderFlush();
      for (const marker of [
        "LATEST_USER",
        "LATEST_ASSISTANT",
        "LATEST_TOOL",
        "LATEST_RESULT",
      ]) {
        expect(
          bufferLines().filter((line) => line.includes(marker)),
          marker,
        ).toHaveLength(1);
      }
      for (const [cycle, { heights, finalRows }] of [
        { heights: [24, 12, 5, 40], finalRows: 40 },
        { heights: [12, 5, 24], finalRows: 24 },
        { heights: [5, 60], finalRows: 60 },
        { heights: [24, 12, 5, 40], finalRows: 40 },
      ].entries()) {
        act(() => {
          for (const rows of heights) {
            terminal.resize(120, rows);
          }
          stdout.rows = finalRows;
          stdout.emit("resize");
        });
        await instance?.waitUntilRenderFlush();
        for (const marker of [
          "LATEST_USER",
          "LATEST_ASSISTANT",
          "LATEST_TOOL",
          "LATEST_RESULT",
        ]) {
          expect(
            bufferLines().filter((line) => line.includes(marker)),
            JSON.stringify({ cycle, marker, lines: bufferLines().slice(-65) }),
          ).toHaveLength(1);
        }
        messages.push({
          role: "assistant",
          content: `AFTER_HEIGHT_${String(cycle)}`,
        });
        act(() => instance?.rerender(scene()));
        await instance?.waitUntilRenderFlush();
        const lines = bufferLines();
        for (const marker of [
          "saved-59",
          "LATEST_USER",
          "LATEST_ASSISTANT",
          "LATEST_TOOL",
          "LATEST_RESULT",
          `AFTER_HEIGHT_${String(cycle)}`,
        ]) {
          expect(
            lines.filter((line) => line.includes(marker)),
            JSON.stringify({ cycle, marker, lines: lines.slice(-70) }),
          ).toHaveLength(1);
        }
      }
    },
  );

  it.each([
    { historyRows: 1, working: false },
    { historyRows: 60, working: false },
    { historyRows: 60, working: true },
  ])(
    "keeps the dock and footer visible with $historyRows saved messages and working=$working",
    async ({ historyRows, working }) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      terminal.options.scrollback = 10_000;
      act(() => {
        instance = render(
          createElement(Scene, {
            historyRows,
            working,
            activity: working
              ? createElement(Text, {}, "LIVE_ROW 中文内容 ".repeat(300))
              : null,
          }),
          {
            stdout,
            stdin,
            stderr: stdout,
            interactive: true,
            patchConsole: false,
            exitOnCtrlC: false,
          },
        );
      });
      await instance?.waitUntilRenderFlush();
      await act(async () => {
        virtualTerminal.inputStream.write("日本語 input");
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
      await instance?.waitUntilRenderFlush();
      for (let cycle = 0; cycle < 3; cycle++) {
        for (const [columns, rows] of [
          [80, 40],
          [60, 40],
          [120, 40],
          [160, 40],
          [72, 24],
          [140, 40],
          [48, 12],
          [32, 5],
          [120, 40],
        ]) {
          await resize(columns, rows);
          act(() => {
            vi.advanceTimersByTime(100);
          });
          await instance?.waitUntilRenderFlush();
          const buffer = terminal.buffer.active;
          const visible = bufferLines().slice(buffer.baseY);
          expect(
            visible.filter((line) => line.includes("Plan")),
            JSON.stringify({ cycle, columns, rows, visible }),
          ).toHaveLength(rows >= 6 ? 1 : 0);
          expect(
            buffer
              .getLine(buffer.baseY + buffer.cursorY)
              ?.translateToString(true),
          ).toContain("日本語 input");
          expect(
            bufferLines().filter((line) =>
              line.includes(`saved-${String(historyRows - 1)}`),
            ),
            JSON.stringify({
              cycle,
              columns,
              rows,
              bufferLength: buffer.length,
              lines: bufferLines().slice(-65),
            }),
          ).toHaveLength(1);
        }
        act(() => {
          for (const columns of [80, 32, 120]) {
            terminal.resize(columns, 40);
            stdout.columns = columns;
            stdout.emit("resize");
          }
        });
        await instance?.waitUntilRenderFlush();
        expect(
          bufferLines()
            .slice(terminal.buffer.active.baseY)
            .filter((line) => line.includes("Plan")),
        ).toHaveLength(1);
      }
      expect(output.join("")).not.toContain("\x1b[3J");
      expect(output.join("")).not.toContain("\x1b[?1049h");
    },
  );

  it("keeps completed table grids in native history without replaying them on resize", async () => {
    const source = [
      "| 使用场景 | 推荐工具 |",
      "| --- | --- |",
      "| 企业统一管理（SSO/SCIM、Registry 管控、审计、ECI） | **Docker Desktop Business** |",
      "| Linux 服务器 / CI | **Docker Engine + CLI** |",
    ].join("\n");
    act(() => {
      instance = render(
        createElement(Scene, {
          messages: [{ role: "assistant", content: source }],
        }),
        {
          stdout,
          stdin,
          stderr: stdout,
          interactive: true,
          patchConsole: false,
          exitOnCtrlC: false,
        },
      );
    });
    await instance?.waitUntilRenderFlush();
    for (const columns of [80, 40, 120, 32, 96]) {
      await resize(columns);
      const history = bufferLines().join("").replaceAll(/\s/gu, "");
      for (const value of [
        "企业统一管理（SSO/SCIM、Registry管控、审计、ECI）",
        "DockerDesktopBusiness",
        "Linux服务器/CI",
        "DockerEngine+CLI",
      ]) {
        expect(history).toContain(value);
      }
      expect(history.match(/┌/gu)).toHaveLength(1);
      expect(output.join("").match(/┌/gu)).toHaveLength(1);
      expect(history).not.toContain("使用场景:");
      expect(history).not.toContain("推荐工具:");
      expect(history).not.toContain("|---|");
    }
  });

  it("preserves the newest committed tool card through terminal height changes", async () => {
    const messages: ChatMessage[] = [
      ...Array.from({ length: 100 }, (_, index) => ({
        role: "assistant" as const,
        content: `saved-${String(index)}`,
      })),
      {
        role: "turn_summary",
        content: "",
        toolSummary: [
          {
            toolName: "ReadFile",
            argsSummary: "COMMITTED_CARD",
            output: Array.from(
              { length: 10 },
              (_, line) => `COMMITTED_LINE_${String(line)}`,
            ).join("\n"),
            isError: false,
            elapsed: 0.1,
          },
        ],
      },
    ];
    act(() => {
      instance = render(createElement(Scene, { messages }), {
        stdout,
        stdin,
        stderr: stdout,
        interactive: true,
        patchConsole: false,
        exitOnCtrlC: false,
      });
    });
    await instance?.waitUntilRenderFlush();
    for (const rows of [24, 12, 5, 40, 60, 18, 40]) {
      await resize(120, rows);
      const text = bufferLines().join("\n");
      for (let line = 0; line < 10; line++) {
        expect(
          text,
          JSON.stringify({ rows, tail: bufferLines().slice(-65) }),
        ).toContain(`COMMITTED_LINE_${String(line)}`);
      }
    }
  });

  it.each([
    { count: 1, batched: true },
    { count: 3, batched: true },
    { count: 3, batched: false },
  ])(
    "restores the full height of $count live tool cards after terminal height changes with batched=$batched",
    async ({ count, batched }) => {
      const activity = createElement(
        Fragment,
        {},
        createElement(ChatView, {
          streamingText: "STREAMING_CONTENT\n\n".repeat(40),
        }),
        createElement(
          Box,
          { flexDirection: "column" },
          ...Array.from({ length: count }, (_, index) =>
            createElement(ToolCard, {
              key: index,
              toolName: "ReadFile",
              argsSummary: `CARD_${String(index)}`,
              output: Array.from(
                { length: 10 },
                (_, line) => `CARD_${String(index)}_LINE_${String(line)}`,
              ).join("\n"),
              loading: true,
            }),
          ),
        ),
      );
      act(() => {
        instance = render(
          createElement(Scene, { historyRows: 100, working: true, activity }),
          {
            stdout,
            stdin,
            stderr: stdout,
            interactive: true,
            patchConsole: false,
            exitOnCtrlC: false,
          },
        );
      });
      await instance?.waitUntilRenderFlush();
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", batched);
      for (const rows of [60, 24, 12, 5, 40, 60, 18, 60]) {
        if (batched) {
          await resize(120, rows);
        } else {
          terminal.resize(120, rows);
          stdout.rows = rows;
          stdout.emit("resize");
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          await instance?.waitUntilRenderFlush();
        }
        expect(
          bufferLines()
            .map((line) => line.trim())
            .filter((line) => /^saved-\d+$/u.test(line)),
        ).toEqual(
          Array.from({ length: 100 }, (_, index) => `saved-${String(index)}`),
        );
        if (rows >= 10) {
          expect(
            bufferLines().slice(terminal.buffer.active.baseY).join("\n"),
          ).toContain(`CARD_${String(count - 1)}_LINE_9`);
        }
        if (rows < 24) {
          continue;
        }
        const visible = bufferLines()
          .slice(terminal.buffer.active.baseY)
          .join("\n");
        for (let index = rows >= 60 ? 0 : count - 1; index < count; index++) {
          for (let line = 0; line < 10; line++) {
            const marker = `CARD_${String(index)}_LINE_${String(line)}`;
            expect(
              visible,
              JSON.stringify({ rows, index, line, visible }),
            ).toContain(marker);
            expect(
              visible.split("\n").filter((text) => text.includes(marker)),
            ).toHaveLength(1);
            const cardRow =
              terminal.buffer.active.baseY +
              visible.split("\n").findIndex((text) => text.includes(marker));
            expect(
              terminal.buffer.active.getLine(cardRow)?.getCell(0)?.getBgColor(),
            ).toBe(Number.parseInt(THEME.toolPendingBg.slice(1), 16));
          }
        }
      }
    },
  );

  it("restores live cards after a height resize burst returns to the original dimensions", async () => {
    const activity = createElement(ToolCard, {
      toolName: "ReadFile",
      argsSummary: "BURST_CARD",
      output: Array.from(
        { length: 10 },
        (_, line) => `BURST_LINE_${String(line)}`,
      ).join("\n"),
      loading: true,
    });
    act(() => {
      instance = render(
        createElement(Scene, { historyRows: 100, working: true, activity }),
        {
          stdout,
          stdin,
          stderr: stdout,
          interactive: true,
          patchConsole: false,
          exitOnCtrlC: false,
        },
      );
    });
    await instance?.waitUntilRenderFlush();
    for (let cycle = 0; cycle < 5; cycle++) {
      act(() => {
        for (const rows of [24, 12, 5, 40]) {
          terminal.resize(120, rows);
          stdout.rows = rows;
          stdout.emit("resize");
        }
      });
      await instance?.waitUntilRenderFlush();
      const lines = bufferLines();
      for (let line = 0; line < 10; line++) {
        expect(
          lines.filter((text) => text.includes(`BURST_LINE_${String(line)}`)),
          JSON.stringify({ cycle, lines: lines.slice(-60) }),
        ).toHaveLength(1);
      }
      expect(lines.filter((line) => line.includes("saved-99"))).toHaveLength(1);
    }
  });

  it.each(["included in next", "excluded in next"])(
    "shows a newly started user shell card %s model context before any output",
    async (policy) => {
      act(() => {
        instance = render(createElement(Scene), {
          stdout,
          stdin,
          stderr: stdout,
          interactive: true,
          patchConsole: false,
          exitOnCtrlC: false,
        });
      });
      await instance?.waitUntilRenderFlush();
      act(() => {
        instance?.rerender(
          createElement(Scene, {
            working: true,
            activity: createElement(ToolCard, {
              toolName: "Bash",
              argsSummary: "node ./execute-a-long-time.mjs",
              loading: true,
              progress: `User command · ${policy} model context`,
            }),
          }),
        );
      });
      await instance?.waitUntilRenderFlush();
      const visible = bufferLines()
        .slice(terminal.buffer.active.baseY)
        .join("\n");
      expect(visible).toContain("$ node ./execute-a-long-time.mjs");
      expect(visible).toContain("running");
      expect(visible).toContain(`User command · ${policy} model context`);
    },
  );

  it.each([24, 40])(
    "preserves every recent message through repeated width changes with a tall live frame at %i rows",
    async (rows) => {
      terminal.resize(120, rows);
      stdout.rows = rows;
      const messages: ChatMessage[] = Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: Array.from(
          { length: 5 },
          (_, line) =>
            `MESSAGE_${String(index)}_LINE_${String(line)} ` +
            "消息内容和终端宽度变化 ".repeat(5),
        ).join("\n\n"),
      }));
      act(() => {
        instance = render(
          createElement(Scene, {
            messages,
            working: true,
            activity: createElement(Text, {}, "LIVE_CONTENT\n".repeat(50)),
          }),
          {
            stdout,
            stdin,
            stderr: stdout,
            interactive: true,
            patchConsole: false,
            exitOnCtrlC: false,
          },
        );
      });
      await instance?.waitUntilRenderFlush();
      const historyText = () => {
        const lines = bufferLines();
        const liveStart = lines.findIndex((line) =>
          line.startsWith("LIVE_CONTENT"),
        );
        expect(liveStart).toBeGreaterThanOrEqual(0);
        return lines.slice(0, liveStart).join("").replaceAll(/\s/gu, "");
      };
      let expectedHistory = historyText();
      for (let cycle = 0; cycle < 5; cycle++) {
        for (const columns of [80, 48, 120, 32, 96]) {
          await resize(columns, rows);
          const lines = bufferLines();
          for (let index = 0; index < 8; index++) {
            for (let line = 0; line < 5; line++) {
              const marker = `MESSAGE_${String(index)}_LINE_${String(line)}`;
              expect(
                lines.filter((text) => text.includes(marker)),
                JSON.stringify({
                  cycle,
                  columns,
                  marker,
                  last: lines.slice(-50),
                }),
              ).toHaveLength(1);
            }
          }
          expect(historyText(), JSON.stringify({ cycle, columns })).toBe(
            expectedHistory,
          );
        }
        const content = `COMMITTED_${String(cycle)} 新消息也必须完整保留。`;
        messages.push({ role: "user", content });
        act(() => {
          instance?.rerender(
            createElement(Scene, {
              messages: messages.slice(),
              working: true,
              activity: createElement(Text, {}, "LIVE_CONTENT\n".repeat(50)),
            }),
          );
        });
        await instance?.waitUntilRenderFlush();
        expectedHistory += content.replaceAll(/\s/gu, "");
        expect(historyText()).toBe(expectedHistory);
      }
      expect(output.join("")).not.toContain("\x1b[2J");
    },
  );
  it("preserves a wide character in the last two columns of the live area", async () => {
    act(() => {
      instance = render(
        createElement(Scene, { activity: createElement(RightEdgeText) }),
        {
          stdout,
          stdin,
          stderr: stdout,
          interactive: true,
          patchConsole: false,
          exitOnCtrlC: false,
        },
      );
    });
    await instance?.waitUntilRenderFlush();
    for (const columns of [80, 41, 120, 33, 96]) {
      await resize(columns);
      const line = bufferLines().find((line) => line.startsWith("EDGE_"));
      expect(line).toBe("EDGE_" + "x".repeat(columns - 7) + "日");
    }
  });
  it("keeps reflowed live output out of native scrollback", async () => {
    act(() => {
      instance = render(
        createElement(Scene, {
          historyRows: 100,
          activity: createElement(
            Text,
            {},
            Array.from(
              { length: 30 },
              (_, index) => `LIVE_ROW_${String(index)} ` + "x".repeat(100),
            ).join("\n"),
          ),
        }),
        {
          stdout,
          stdin,
          stderr: stdout,
          interactive: true,
          patchConsole: false,
          exitOnCtrlC: false,
        },
      );
    });
    await instance?.waitUntilRenderFlush();
    for (const columns of [80, 32, 120, 48, 96]) {
      await resize(columns);
      const history = bufferLines().slice(0, terminal.buffer.active.baseY);
      expect(
        history.filter((line) => line.includes("LIVE_ROW_")),
        JSON.stringify({ columns, history: history.slice(-70) }),
      ).toEqual([]);
    }
  });
  it("does not leave animated Working frames in scrollback during unbatched resizing", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
    const messages: ChatMessage[] = Array.from({ length: 100 }, (_, index) => ({
      role: "assistant",
      content: `saved-${String(index)}`,
    }));
    instance = render(
      createElement(Scene, {
        messages,
        working: true,
        activity: createElement(ToolCard, {
          toolName: "ReadFile",
          argsSummary: "src/layout.ts",
          output: "LIVE_TOOL\n" + "long tool output ".repeat(200),
          isError: false,
          elapsed: 0.1,
          expanded: true,
        }),
      }),
      {
        stdout,
        stdin,
        stderr: stdout,
        interactive: true,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    );
    await instance?.waitUntilRenderFlush();
    for (const columns of [80, 32, 120, 48, 120, 60, 96]) {
      terminal.resize(columns, 40);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      stdout.columns = columns;
      stdout.emit("resize");
      messages.push({
        role: "user",
        content: `RESIZE_USER_${String(columns)}`,
      });
      instance?.rerender(
        createElement(Scene, {
          messages: messages.slice(),
          working: true,
          activity: createElement(ToolCard, {
            toolName: "ReadFile",
            argsSummary: "src/layout.ts",
            output: "LIVE_TOOL\n" + "long tool output ".repeat(200),
            isError: false,
            elapsed: 0.1,
            expanded: true,
          }),
        }),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      await instance?.waitUntilRenderFlush();
      const lines = bufferLines();
      expect(
        lines.filter((line) => line.includes("Working")),
        JSON.stringify({ columns, lines: lines.slice(-100) }),
      ).toHaveLength(1);
      expect(
        lines.filter((line) => /^─+$/u.test(line)),
        JSON.stringify({ columns, lines: lines.slice(-100) }),
      ).toHaveLength(1);
    }
  });

  it("keeps short card padding from turning into wrapped background stripes", async () => {
    act(() => {
      instance = render(
        createElement(Scene, {
          messages: [
            { role: "user", content: "USER_CARD short text" },
            {
              role: "turn_summary",
              content: "",
              toolSummary: [
                {
                  toolName: "TestTool",
                  argsSummary: "",
                  output: "TOOL_CARD short text",
                  isError: false,
                  elapsed: 0.1,
                },
              ],
            },
          ],
        }),
        {
          stdout,
          stdin,
          stderr: stdout,
          interactive: true,
          patchConsole: false,
          exitOnCtrlC: false,
        },
      );
    });
    await instance?.waitUntilRenderFlush();
    let backgroundWidth = 120;
    for (const columns of [80, 96, 40, 120]) {
      await resize(columns);
      backgroundWidth = Math.min(backgroundWidth, columns);
      const lines = bufferLines();
      for (const [marker, color] of [
        ["USER_CARD", THEME.userMessageBg],
        ["TOOL_CARD", THEME.toolSuccessBg],
      ]) {
        const row = lines.findIndex((line) => line.includes(marker));
        for (let index = row - 1; index <= row + 1; index++) {
          for (let column = 0; column < backgroundWidth; column++) {
            expect(
              terminal.buffer.active
                .getLine(index)
                ?.getCell(column)
                ?.getBgColor(),
              JSON.stringify({ index, column, columns, lines }),
            ).toBe(Number.parseInt(color.slice(1), 16));
          }
        }
      }
    }
  });
  it("redraws live tool cards with wide text while preserving native history", async () => {
    act(() => {
      instance = render(
        createElement(Scene, {
          historyRows: 100,
          activity: createElement(ToolCard, {
            toolName: "ReadFile",
            argsSummary: "日本語.ts",
            output:
              "ツールカードには日本語と ANSI の背景色があり、幅の変更時に正しく折り返します。 ".repeat(
                8,
              ),
            isError: false,
            elapsed: 0.1,
            expanded: true,
          }),
        }),
        {
          stdout,
          stdin,
          stderr: stdout,
          interactive: true,
          patchConsole: false,
          exitOnCtrlC: false,
        },
      );
    });
    await instance?.waitUntilRenderFlush();
    terminal.scrollToLine(40);
    for (const columns of [79, 41, 120, 33, 96]) {
      const readingPosition = await resize(columns);
      const lines = bufferLines();
      const visible = lines.slice(terminal.buffer.active.baseY);
      expect(terminal.buffer.active.viewportY).toBe(readingPosition);
      expect(lines.filter((line) => line.includes("Yukino v"))).toHaveLength(1);
      expect(
        lines.filter((line) => line.includes("saved-99")),
        JSON.stringify({ columns, lines: lines.slice(-60) }),
      ).toHaveLength(1);
      expect(visible.filter((line) => line.includes("ReadFile"))).toHaveLength(
        1,
      );
      expect(
        visible.filter((line) => line.includes("8 teammates")),
      ).toHaveLength(1);
      expect(visible.filter((line) => /^─+$/u.test(line))).toHaveLength(2);
    }
  });

  it("preserves native scrollback anchors and the reading position during resize", async () => {
    act(() => {
      instance = render(createElement(Scene, { historyRows: 100 }), {
        stdout,
        stdin,
        stderr: stdout,
        interactive: true,
        patchConsole: false,
        exitOnCtrlC: false,
      });
    });
    await instance?.waitUntilRenderFlush();
    const buffer = terminal.buffer.active;
    const anchor = terminal.registerMarker(40 - buffer.baseY - buffer.cursorY);
    for (const columns of [80, 48, 120, 32, 96]) {
      terminal.scrollToLine(40);
      terminal.resize(columns, 40);
      const readingPosition = buffer.viewportY;
      const visibleLine = buffer
        .getLine(readingPosition)
        ?.translateToString(true);
      act(() => {
        stdout.columns = columns;
        stdout.emit("resize");
      });
      await instance?.waitUntilRenderFlush();

      expect(anchor?.isDisposed).toBe(false);
      expect(buffer.viewportY).toBe(readingPosition);
      expect(buffer.getLine(buffer.viewportY)?.translateToString(true)).toBe(
        visibleLine,
      );
    }
  });

  it.each([
    { historyRows: 1, nativeCursor: true },
    { historyRows: 60, nativeCursor: true },
    { historyRows: 1, nativeCursor: false },
  ])(
    "clears reflowed frames with $historyRows saved messages and nativeCursor=$nativeCursor",
    async (props) => {
      act(() => {
        instance = render(createElement(Scene, props), {
          stdout,
          stdin,
          stderr: stdout,
          interactive: true,
          patchConsole: false,
          exitOnCtrlC: false,
        });
      });
      await instance?.waitUntilRenderFlush();
      if (props.nativeCursor) {
        await act(async () => {
          virtualTerminal.inputStream.write("日本語 input");
          await new Promise<void>((resolve) => setImmediate(resolve));
        });
        await instance?.waitUntilRenderFlush();
      }

      for (const columns of [80, 60, 120, 48, 80, 32, 120]) {
        await resize(columns);
        const all = bufferLines();
        const visible = all.slice(terminal.buffer.active.baseY);
        expect(
          visible.filter((line) => line.includes("8 teammates")),
        ).toHaveLength(1);
        expect(visible.filter((line) => /^─+$/u.test(line))).toHaveLength(
          props.nativeCursor ? 2 : 1,
        );
        expect(
          all.filter((line) =>
            line.includes(`saved-${String(props.historyRows - 1)}`),
          ),
          JSON.stringify({ columns, all }),
        ).toHaveLength(1);
        if (props.nativeCursor) {
          const buffer = terminal.buffer.active;
          expect(
            buffer
              .getLine(buffer.baseY + buffer.cursorY)
              ?.translateToString(true),
          ).toContain("日本語 input");
        }
      }
      expect(output.join("")).not.toContain("\x1b[3J");
      expect(output.join("")).not.toContain("\x1b[?1049h");
    },
  );

  it("retains saved messages and lays out newly committed cards at the current width", async () => {
    const prose =
      "端末の幅が変わっても、すべてのメッセージを保ち、折り返しを調整します。 ".repeat(
        5,
      );
    const messages: ChatMessage[] = [
      { role: "user", content: `USER_CARD ${prose}` },
      { role: "assistant", content: `ASSISTANT_TEXT ${prose}` },
      {
        role: "turn_summary",
        content: "Reviewing the changes",
        thinkingDuration: 1.7,
        toolSummary: [
          {
            toolName: "ReadFile",
            argsSummary: "src/ui/layout.ts",
            output: `TOOL_RESULT ${prose}`,
            isError: false,
            elapsed: 0.1,
          },
        ],
      },
    ];
    act(() => {
      instance = render(createElement(Scene, { messages }), {
        stdout,
        stdin,
        stderr: stdout,
        interactive: true,
        patchConsole: false,
        exitOnCtrlC: false,
      });
    });
    await instance?.waitUntilRenderFlush();

    for (const columns of [240, 72, 40, 120, 32, 96]) {
      await resize(columns);
      const lines = bufferLines();
      for (const marker of [
        "USER_CARD",
        "ASSISTANT_TEXT",
        "TOOL_RESULT",
        "ReadFile",
      ]) {
        expect(lines.filter((line) => line.includes(marker))).toHaveLength(1);
      }
      expect(lines.filter((line) => line.includes("Yukino v"))).toHaveLength(1);
      messages.push(
        { role: "user", content: `NEW_USER_${String(columns)} ${prose}` },
        {
          role: "turn_summary",
          content: "",
          toolSummary: [
            {
              toolName: "ResizeTool",
              argsSummary: "",
              output: `NEW_TOOL_${String(columns)} ${prose}`,
              isError: false,
              elapsed: 0.1,
            },
          ],
        },
      );
      act(() => {
        instance?.rerender(
          createElement(Scene, { messages: messages.slice() }),
        );
      });
      await instance?.waitUntilRenderFlush();
      const committed = bufferLines();
      for (const [marker, color] of [
        [`NEW_USER_${String(columns)}`, THEME.userMessageBg],
        [`NEW_TOOL_${String(columns)}`, THEME.toolSuccessBg],
      ]) {
        const row = committed.findIndex((line) => line.includes(marker));
        expect(row).toBeGreaterThanOrEqual(0);
        expect(committed.filter((line) => line.includes(marker))).toHaveLength(
          1,
        );
        for (let column = 0; column < columns; column++) {
          expect(
            terminal.buffer.active.getLine(row)?.getCell(column)?.getBgColor(),
          ).toBe(Number.parseInt(color.slice(1), 16));
        }
      }
    }
  });

  it("preserves history and restores the live frame after a burst returns to the original width", async () => {
    act(() => {
      instance = render(createElement(Scene), {
        stdout,
        stdin,
        stderr: stdout,
        interactive: true,
        patchConsole: false,
        exitOnCtrlC: false,
      });
    });
    await instance?.waitUntilRenderFlush();
    act(() => {
      for (const columns of [80, 32, 120]) {
        terminal.resize(columns, 40);
        stdout.columns = columns;
        stdout.emit("resize");
      }
    });
    await instance?.waitUntilRenderFlush();
    const lines = bufferLines();
    expect(lines.filter((line) => line.includes("Yukino v"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("saved-0"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("8 teammates"))).toHaveLength(
      1,
    );
    expect(lines.filter((line) => /^─+$/u.test(line))).toHaveLength(2);
  });

  it.each([5, 12, 40])(
    "keeps messages committed in the same turn as a resize to %i rows",
    async (rows) => {
      const messages: ChatMessage[] = [
        { role: "assistant", content: "BEFORE_RESIZE" },
      ];
      const activity = createElement(Text, {}, "LIVE_CONTENT\n".repeat(50));
      act(() => {
        instance = render(createElement(Scene, { messages, activity }), {
          stdout,
          stdin,
          stderr: stdout,
          interactive: true,
          patchConsole: false,
          exitOnCtrlC: false,
        });
      });
      await instance?.waitUntilRenderFlush();
      act(() => {
        terminal.resize(80, rows);
        stdout.columns = 80;
        stdout.rows = rows;
        stdout.emit("resize");
        instance?.rerender(
          createElement(Scene, {
            activity,
            messages: [
              ...messages,
              { role: "assistant", content: "DURING_RESIZE" },
            ],
          }),
        );
      });
      await instance?.waitUntilRenderFlush();
      await resize(80, 40);
      const lines = bufferLines();
      for (const marker of [
        "BEFORE_RESIZE",
        "DURING_RESIZE",
        "Yukino v",
        "8 teammates",
      ]) {
        expect(
          lines.filter((line) => line.includes(marker)),
          JSON.stringify({ marker, lines: lines.slice(-80) }),
        ).toHaveLength(1);
      }
      expect(lines.filter((line) => /^─+$/u.test(line))).toHaveLength(2);
    },
  );

  it("preserves scrollback when width and height change together", async () => {
    act(() => {
      instance = render(createElement(Scene, { historyRows: 100 }), {
        stdout,
        stdin,
        stderr: stdout,
        interactive: true,
        patchConsole: false,
        exitOnCtrlC: false,
      });
    });
    await instance?.waitUntilRenderFlush();
    terminal.scrollToLine(40);
    for (const [columns, rows] of [
      [80, 5],
      [120, 40],
      [48, 12],
      [96, 40],
    ]) {
      const readingPosition = await resize(columns, rows);
      const lines = bufferLines();
      expect(terminal.buffer.active.viewportY).toBe(readingPosition);
      expect(lines.filter((line) => line.includes("Yukino v"))).toHaveLength(1);
      expect(
        lines.filter((line) => line.includes("saved-99")),
        JSON.stringify({
          columns,
          rows,
          lines: lines.slice(-60),
          lastOutput: output.slice(-6),
        }),
      ).toHaveLength(1);
      expect(output.join("")).not.toContain("\x1b[3J");
    }
  });
});
