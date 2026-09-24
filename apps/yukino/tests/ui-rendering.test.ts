/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { stripVTControlCharacters } from "node:util";

import chalk, { Chalk } from "chalk";
import { renderToString } from "ink";
import type * as Ink from "ink";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runInline } from "@/skills/executor.js";
import { AgentActivity } from "@/ui/agent-activity.js";
import { CommittedMessage } from "@/ui/chat.js";
import { Footer } from "@/ui/footer.js";
import {
  renderMarkdown,
  renderStreamingMarkdown,
  type MarkdownCache,
} from "@/ui/markdown.js";
import { setThemeMode, THEME, thinkingLevelColor } from "@/ui/styles.js";
import {
  truncateToWidth,
  visibleWidth,
  wrapToLines,
} from "@/ui/terminal-text.js";
import { ThinkingBlock } from "@/ui/thinking-block.js";
import { ToolBlock } from "@/ui/tool-display.js";
import { formatToolOutputPreview } from "@/ui/tool-preview.js";

// ToolCard and ThinkingBlock size themselves from useStdout().stdout.columns, which
// renderToString never provides — Ink returns the process.stdout default (columns
// undefined under vitest, so they fall back to 80). Mock useStdout so the { columns }
// argument passed to renderToString actually constrains the rendered cards.
const terminal = vi.hoisted(() => ({ columns: 40 }));

vi.mock("ink", async (importOriginal) => {
  const ink = await importOriginal<typeof Ink>();
  return {
    ...ink,
    useStdout: () => ({ stdout: { columns: terminal.columns, rows: 24 } }),
  };
});

const colors = new Chalk({ level: 3 });
const initialColorLevel = chalk.level;
beforeEach(() => {
  terminal.columns = 40;
  chalk.level = 0;
});
afterEach(() => {
  setThemeMode("dark");
  chalk.level = initialColorLevel;
});

describe("terminal column handling", () => {
  it("measures ANSI, CJK and combining characters without splitting glyphs", () => {
    const text = colors.red("日本e\u0301");
    expect(visibleWidth(text)).toBe(5);
    expect(visibleWidth(truncateToWidth(text, 4))).toBeLessThanOrEqual(4);
    expect(stripVTControlCharacters(truncateToWidth(text, 4))).toBe("日…");
    expect(
      wrapToLines(colors.green("文章文章"), 4).map(stripVTControlCharacters),
    ).toEqual(["文章", "文章"]);
    expect(truncateToWidth(text, 0)).toBe("");
  });

  it("counts shell previews in visual lines", () => {
    const output = "1234567890".repeat(6);
    const preview = stripVTControlCharacters(
      formatToolOutputPreview("Bash", output, 10),
    );
    expect(preview.split("\n").slice(0, 5)).toEqual(
      Array.from({ length: 5 }, () => "1234567890"),
    );
    expect(preview).toContain("1 more lines");
  });
});

describe("skill transcript presentation", () => {
  const prompt = runInline(
    {
      meta: { name: "demo", description: "Local skill" },
      sourceDir: "/project/skills/demo",
      isDirectory: true,
      body: "## Skill details\n\nHidden body.",
    },
    "Update <docs> & keep &lt; literal\nSecond line 日本語",
    { activateSkill: () => undefined },
  );

  it.each([20, 40, 100])(
    "separates the skill card and arguments at %i columns",
    (columns) => {
      terminal.columns = columns;
      for (const theme of ["light", "dark"] as const) {
        setThemeMode(theme);
        for (const expanded of [false, true]) {
          const output = stripVTControlCharacters(
            renderToString(
              createElement(CommittedMessage, {
                message: { role: "user", content: prompt },
                expanded,
              }),
              { columns },
            ),
          );
          const normalized = output.replace(/\s+/gu, " ");
          expect(normalized).toContain("[skill] demo");
          expect(normalized).toContain(
            `Ctrl+O to ${expanded ? "collapse" : "expand"}`,
          );
          expect(normalized).toContain("Update <docs> & keep &lt; literal");
          expect(output).toMatch(/literal\s*\n\s*Second line 日本語/u);
          expect(normalized.includes("Hidden body.")).toBe(expanded);
          expect(output).not.toContain("<skill-body>");
          expect(output).not.toContain("<skill-arguments>");
          expect(output).not.toContain("host tool permissions");
          expect(
            output.split("\n").every((line) => visibleWidth(line) <= columns),
          ).toBe(true);
        }
      }
    },
  );

  it("shows only the skill card when no arguments were supplied", () => {
    terminal.columns = 100;
    const content = prompt.replace(/\n\n<skill-arguments>[\s\S]*$/u, "");
    const output = stripVTControlCharacters(
      renderToString(
        createElement(CommittedMessage, { message: { role: "user", content } }),
        {
          columns: 100,
        },
      ),
    );
    expect(output.trim()).toBe("[skill] demo (Ctrl+O to expand)");
  });

  it("does not collapse skill-like markup in ordinary user messages", () => {
    const output = stripVTControlCharacters(
      renderToString(
        createElement(CommittedMessage, {
          message: {
            role: "user",
            content: "Explain <skill-body>markup</skill-body>",
          },
        }),
        { columns: 40 },
      ),
    );
    expect(output.replace(/\s+/gu, "")).toContain(
      "Explain<skill-body>markup</skill-body>",
    );
    expect(output).not.toContain("Ctrl+O");
  });
});

describe("pi Markdown presentation", () => {
  it.each(["```", "~~~~"])(
    "does not flash partial closing %s fences during streaming",
    (fence) => {
      const cache: MarkdownCache = {
        prefix: "",
        rendered: "",
        width: 0,
        theme: "",
      };
      const source = `${fence}ts\nconst value = 1;\n`;
      const expected = renderMarkdown(source + fence, 40);
      for (let count = 1; count < fence.length; count++) {
        expect(
          renderStreamingMarkdown(source + fence.slice(0, count), 40, cache),
        ).toBe(expected);
      }
      // Completed content is never silently stripped, even if it ends in fence-like text.
      expect(renderMarkdown(source + fence[0], 40)).not.toBe(expected);
      expect(renderStreamingMarkdown(source + fence[0] + "\n", 40, cache)).toBe(
        renderMarkdown(source + fence[0] + "\n", 40),
      );
      expect(
        renderStreamingMarkdown(`${fence}ts\n${fence[0]}`, 40, cache),
      ).toBe(renderMarkdown(`${fence}ts\n${fence}`, 40));
    },
  );
  it.each([20, 40, 80, 120])(
    "fits long text, code and tables in %i columns",
    (width) => {
      for (const source of [
        "日本語テスト".repeat(30),
        "```unknown-language\n" + "const value = 123; ".repeat(20) + "\n```",
        "| Long column one | Long column two |\n| --- | --- |\n| " +
          "value".repeat(15) +
          " | 日本語テスト日本語テスト |",
        "[label](https://example.com/" + "long-path/".repeat(15) + ")",
      ]) {
        expect(
          renderMarkdown(source, width)
            .split("\n")
            .every((line) => visibleWidth(line) <= width),
        ).toBe(true);
      }
    },
  );

  it("wraps wide tables into the terminal instead of dropping to raw Markdown", () => {
    const source = [
      "| Column A | Column B | Column C | Column D |",
      "| --- | --- | --- | --- |",
      "| a very long cell value that keeps going | another long cell value here | third | fourth |",
    ].join("\n");
    const output = stripVTControlCharacters(renderMarkdown(source, 40));
    expect(output).toContain("┌");
    expect(output).not.toContain("| --- |");
    // Columns wrap their cells instead of truncating them.
    expect(output).not.toContain("…");
    for (const line of output.split("\n")) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  it("keeps a wide table inside the message card", () => {
    const source = [
      "| Column A | Column B | Column C | Column D |",
      "| --- | --- | --- | --- |",
      "| a very long cell value that keeps going | another long cell value here | third | fourth |",
    ].join("\n");
    const output = stripVTControlCharacters(
      renderToString(
        createElement(CommittedMessage, {
          message: { role: "assistant", content: source },
        }),
        { columns: 40 },
      ),
    );
    expect(output).toContain("┌");
    for (const line of output.split("\n")) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  it("keeps wide characters inside the table column they belong to", () => {
    const source = [
      "| 名 | 説明 |",
      "| --- | --- |",
      "| 値 | これは長い日本語の説明文で、折り返しの検証用 |",
    ].join("\n");
    const output = stripVTControlCharacters(renderMarkdown(source, 40));
    expect(output).toContain("┌");
    expect(output).not.toContain("…");
    // Wrapping splits between characters, so no text disappears.
    expect(output.replace(/[\s│]/gu, "")).toContain(
      "これは長い日本語の説明文で、折り返しの検証用",
    );
    for (const line of output.split("\n")) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  it("preserves the source numbering and escaped syntax of user messages", () => {
    const text = renderMarkdown("3. first\n8. \\*literal\\*\n", 80, "user");
    const plain = stripVTControlCharacters(text);
    expect(plain).toContain("3. first");
    expect(plain).toContain("8. \\*literal\\*");
  });

  it("leaves scp-style git remotes intact instead of linkifying an email", () => {
    const output = stripVTControlCharacters(
      renderMarkdown(
        "Clone git@github.com:hangtiancheng/yukino-code.git now",
        80,
      ),
    );
    expect(output).toContain("git@github.com:hangtiancheng/yukino-code.git");
    expect(output).not.toContain("mailto:");
  });

  it("keeps email addresses as autolinks without repeating the target", () => {
    chalk.level = 3;
    const output = renderMarkdown("Contact foo@example.com now", 80);
    // The address keeps the href style (underlined), so it stays a link.
    expect(output).toContain("\u001b[4m");
    expect(stripVTControlCharacters(output)).toBe(
      "Contact foo@example.com now",
    );
  });

  it("keeps streamed fences, lists, tables and reference links consistent with committed Markdown", () => {
    const cache: MarkdownCache = {
      prefix: "",
      rendered: "",
      width: 0,
      theme: "",
    };
    const sources = [
      "Intro\n\n```ts\nconst first = 1;\n\nconst second",
      "Intro\n\n```ts\nconst first = 1;\n\nconst second = 2;\n```\n\nDone",
      "Intro\n\n1. one\n2. two\n\nNext",
      "A [reference][target]\n\n[target]: https://example.com",
      "Intro\n\n| Long column one | Long column two |\n| --- | --- |\n| " +
        "value".repeat(15) +
        " | 日本語テスト日本語テスト |",
      "Clone git@github.com:hangtiancheng/yukino-code.git then push",
    ];
    for (const text of sources) {
      expect(renderStreamingMarkdown(text, 40, cache)).toBe(
        renderMarkdown(text, 40),
      );
    }
    setThemeMode("light");
    expect(renderStreamingMarkdown(sources[1], 20, cache)).toBe(
      renderMarkdown(sources[1], 20),
    );
  });

  it("collapses thinking to one line and expands it as italic Markdown", () => {
    const text = "**Reasoning**\n\n" + "detail ".repeat(40);
    const collapsed = renderToString(
      createElement(ThinkingBlock, { text, expanded: false }),
      {
        columns: 40,
      },
    );
    expect(stripVTControlCharacters(collapsed).trim()).toBe(
      "Thinking · Ctrl+O details",
    );
    const expanded = renderToString(
      createElement(ThinkingBlock, { text, expanded: true }),
      {
        columns: 40,
      },
    );
    expect(stripVTControlCharacters(expanded)).toContain("Reasoning");
    expect(stripVTControlCharacters(expanded)).not.toContain("**Reasoning**");
  });
});

describe("shared live and committed tool cards", () => {
  it("keeps every Agent call visible while subagent progress changes", () => {
    terminal.columns = 80;
    const output = stripVTControlCharacters(
      renderToString(
        createElement(AgentActivity, {
          tools: [
            {
              toolId: "a",
              toolName: "Agent",
              args: { description: "first-task" },
              loading: true,
            },
            {
              toolId: "b",
              toolName: "Agent",
              args: { description: "second-task" },
              loading: true,
            },
          ],
          persistentAgentTools: [],
          subagents: [
            {
              toolCallId: "a",
              role: "explorer",
              turnCount: 6,
              activeTools: [],
              status: "completed",
              output: "docs-package",
            },
            {
              toolCallId: "b",
              role: "explorer",
              turnCount: 3,
              activeTools: [{ toolId: "read", toolName: "ReadFile" }],
              status: "running",
            },
          ],
          backgroundTasks: [],
          teammates: [],
          isAsking: false,
          expanded: false,
        }),
        { columns: 40 },
      ),
    );
    expect(output).toContain("Agent first-task  completed");
    expect(output).toContain("explorer subagent | 6 turns");
    expect(output).not.toContain("6 turns | completed");
    expect(output).toContain("Agent second-task  running");
    expect(output).toContain("explorer subagent | 3 turns | ReadFile");
    expect(output).not.toContain("• explorer subagent");
    expect(output.split("\n").every((line) => visibleWidth(line) <= 80)).toBe(
      true,
    );
  });

  it.each([
    ["running", "running", THEME.toolPendingBg],
    ["idle", "completed", THEME.toolSuccessBg],
  ] as const)(
    "maps teammate %s to a %s Agent card",
    (memberStatus, cardStatus, background) => {
      terminal.columns = 80;
      chalk.level = 3;
      const rendered = renderToString(
        createElement(AgentActivity, {
          tools: [],
          persistentAgentTools: [
            {
              toolId: "team-agent",
              toolName: "Agent",
              args: { description: "reviewer", team_name: "squad" },
              output: "Teammate spawned",
              loading: false,
            },
          ],
          subagents: [],
          backgroundTasks: [],
          teammates: [
            {
              name: "reviewer",
              teamName: "squad",
              status: memberStatus,
              originToolCallId: "team-agent",
              progress: {
                toolUseCount: 4,
                turnCount: 2,
                tokenCount: 1300,
                activeTools:
                  memberStatus === "running"
                    ? [{ toolId: "grep", toolName: "Grep" }]
                    : [],
                recentActivities: [],
              },
              startTime: 0,
              spinnerVerb: "working",
            },
          ],
          isAsking: false,
          expanded: false,
        }),
        { columns: 80 },
      );
      const output = stripVTControlCharacters(rendered);
      expect(rendered).toContain(colors.bgHex(background)(" ").split(" ")[0]);
      expect(output).toContain(`Agent reviewer  ${cardStatus}`);
      expect(output).toContain(
        memberStatus === "running"
          ? "@reviewer | Grep | 2 turns | 1.3k tokens"
          : "@reviewer | 2 turns | 1.3k tokens",
      );
      expect(output).not.toContain(`2 turns | ${memberStatus}`);
      expect(output).not.toContain("team lead");
      expect(output).not.toContain("├─");
    },
  );
  it.each(["dark", "light"] as const)(
    "keeps live and saved tool layout identical in %s mode",
    (mode) => {
      setThemeMode(mode);
      const tool = {
        toolId: "read-a",
        toolName: "Read",
        args: { file_path: "src/main.tsx" },
        output: "line one\nline two",
        isError: false,
        elapsed: 0.5,
      };
      const live = renderToString(createElement(ToolBlock, { tool }), {
        columns: 40,
      });
      const saved = renderToString(
        createElement(CommittedMessage, {
          message: {
            role: "turn_summary",
            content: "",
            toolSummary: [
              {
                toolName: tool.toolName,
                argsSummary: "src/main.tsx",
                output: tool.output,
                isError: tool.isError,
                elapsed: tool.elapsed,
              },
            ],
          },
        }),
        { columns: 40 },
      );
      expect(saved).toBe(live);
      const lines = stripVTControlCharacters(live).trim().split("\n");
      expect(lines[0]).toContain("Read src/main.tsx  0.5s");
      expect(lines.map((line) => line.trim())).toEqual([
        "Read src/main.tsx  0.5s",
        "line one",
        "line two",
      ]);
    },
  );

  it("uses command titles for shell calls and hides unknown durations", () => {
    terminal.columns = 20;
    const output = renderToString(
      createElement(ToolBlock, {
        tool: {
          toolId: "bash-a",
          toolName: "Bash",
          args: { command: "pwd" },
          loading: true,
        },
      }),
      { columns: 20 },
    );
    expect(stripVTControlCharacters(output)).toContain("$ pwd");
    expect(stripVTControlCharacters(output)).toContain("running");
    expect(stripVTControlCharacters(output)).not.toContain("Took");
  });

  it.each(["dark", "light"] satisfies ("dark" | "light")[])(
    "retains state backgrounds, diff colors and no-color status in %s mode",
    (mode) => {
      setThemeMode(mode);
      for (const loading of [false, true]) {
        chalk.level = 3;
        const output = renderToString(
          createElement(ToolBlock, {
            tool: {
              toolId: "failed",
              toolName: "Read",
              args: { file_path: "missing.ts" },
              loading,
              isError: !loading,
            },
          }),
          { columns: 40 },
        );
        const background = loading ? THEME.toolPendingBg : THEME.toolErrorBg;
        expect(output).toContain(colors.bgHex(background)(" ").split(" ")[0]);
        expect(stripVTControlCharacters(output)).toContain(
          loading ? "running" : "failed",
        );
        chalk.level = 0;
        const plain = renderToString(
          createElement(ToolBlock, {
            tool: {
              toolId: "status",
              toolName: "Read",
              args: {},
              loading,
              isError: !loading,
            },
          }),
          { columns: 40 },
        );
        expect(plain).toBe(stripVTControlCharacters(plain));
        expect(plain).toContain(loading ? "running" : "failed");
      }
      chalk.level = 3;
      for (const expanded of [false, true]) {
        const diff = renderToString(
          createElement(ToolBlock, {
            tool: {
              toolId: "edit",
              toolName: "EditFile",
              args: {},
              output: "- old\n+ new",
            },
            expanded,
          }),
          { columns: 40 },
        );
        expect(diff).toContain(colors.hex(THEME.toolDiffRemoved)("- old"));
        expect(diff).toContain(colors.hex(THEME.toolDiffAdded)("+ new"));
        expect(diff).toContain(
          colors.bgHex(THEME.toolSuccessBg)(" ").split(" ")[0],
        );
      }
    },
  );

  it("preserves shell preview limits and expands only on request", () => {
    const tool = {
      toolId: "shell",
      toolName: "Bash",
      args: { command: "test" },
      output: Array.from(
        { length: 20 },
        (_, index) => `line-${String(index)}`,
      ).join("\n"),
    };
    const collapsed = stripVTControlCharacters(
      renderToString(createElement(ToolBlock, { tool }), { columns: 40 }),
    );
    expect(collapsed).not.toContain("line-0\n");
    expect(collapsed).toContain("line-19");
    expect(collapsed).toContain("Ctrl+O");
    const expanded = stripVTControlCharacters(
      renderToString(createElement(ToolBlock, { tool, expanded: true }), {
        columns: 40,
      }),
    );
    expect(expanded).toContain("line-0\n");
    expect(expanded).toContain("line-19");
    expect(expanded).not.toContain("more lines");
  });

  it("expands ReadFile tabs so the card never overflows the terminal", () => {
    // ReadFile numbers lines with a literal TAB. string-width counts a TAB as
    // zero columns while a terminal advances to the next 8-column stop, so an
    // unwrapped row fills past the terminal width and wraps onto a bogus
    // background-colored line.
    const output = [
      '1\timport { createFileRoute } from "@tanstack/react-router";',
      "2\t",
      "3\t\tconst nested = 1;",
    ].join("\n");
    const physicalColumns = (row: string): number => {
      let col = 0;
      for (const character of row) {
        col += character === "\t" ? 8 - (col % 8) : 1;
      }
      return col;
    };

    for (const columns of [74, 80, 120, 200]) {
      terminal.columns = columns;
      const frame = renderToString(
        createElement(ToolBlock, {
          tool: {
            toolId: "read",
            toolName: "ReadFile",
            args: { file_path: "src/session.ts" },
            output,
            isError: false,
            elapsed: 0.9,
          },
          expanded: true,
        }),
        { columns },
      );
      const rows = frame.split("\n").map(stripVTControlCharacters);
      expect(rows.some((row) => row.includes("\t"))).toBe(false);
      expect(rows.every((row) => physicalColumns(row) <= columns)).toBe(true);
    }
  });
});

const footerProps = {
  contextTokens: 40_000,
  contextWindow: 200_000,
  inputTokens: 1250,
  outputTokens: 230,
  model: "compact-model",
  permissionMode: "plan",
  provider: "very-long-provider-name",
  sessionId: "01234567-89ab-cdef-0123-456789abcdef",
  workDir: "/workspace/project",
};

describe.each(["dark", "light"] satisfies ("dark" | "light")[])(
  "%s compact presentation",
  (mode) => {
    beforeEach(() => {
      setThemeMode(mode);
    });

    it.each([1, 20, 32, 48, 80, 120])(
      "fits footer, tools and reasoning within %i columns",
      (columns) => {
        terminal.columns = columns;
        for (const colorLevel of [0, 3] satisfies (0 | 3)[]) {
          chalk.level = colorLevel;
          for (const [permissionMode, label] of [
            ["default", "Default"],
            ["acceptEdits", "Accept Edits"],
            ["plan", "Plan"],
            ["bypassPermissions", "YOLO"],
          ]) {
            const footer = stripVTControlCharacters(
              renderToString(
                createElement(Footer, {
                  ...footerProps,
                  permissionMode,
                  thinkingLevel: "high",
                  model: colors.red("機種-".repeat(10)),
                  workDir: colors.green("/作業ディレクトリ/".repeat(10)),
                }),
                { columns },
              ),
            );
            const lines = footer.split("\n");
            expect(lines.every((line) => visibleWidth(line) <= columns)).toBe(
              true,
            );
            const width = columns - (columns > 2 ? 2 : 0);
            if (width < visibleWidth(footerProps.sessionId) + 4) {
              const idRows = wrapToLines(footerProps.sessionId, width);
              expect(
                lines
                  .slice(1, idRows.length + 1)
                  .map((line) => line.trim())
                  .join(""),
              ).toBe(footerProps.sessionId);
            } else {
              expect(footer).toContain(footerProps.sessionId);
            }
            expect(lines.map((line) => line.trim()).join("")).toContain(
              label.replace(/ /g, columns === 1 ? "" : " "),
            );
            if (columns >= 20) {
              expect(footer).toContain("機種");
              expect(footer).toContain("high");
              expect(footer).toContain("20.0%/200k");
            }
          }
          for (const expanded of [false, true]) {
            for (const node of [
              createElement(ThinkingBlock, {
                text: colors.red("日本語 reasoning ".repeat(30)),
                expanded,
              }),
              createElement(ToolBlock, {
                tool: {
                  toolId: "wide",
                  toolName: "Read",
                  args: { file_path: colors.red("日本語".repeat(20)) },
                  output: colors.green("日本語 output ".repeat(30)),
                  isError: true,
                },
                expanded,
              }),
            ]) {
              const output = renderToString(node, { columns });
              expect(
                output
                  .split("\n")
                  .every((line) => visibleWidth(line) <= columns),
              ).toBe(true);
              if (!expanded && columns >= 20 && node.type === ThinkingBlock) {
                expect(stripVTControlCharacters(output)).toContain("Ctrl+O");
                expect(stripVTControlCharacters(output)).not.toContain(
                  "Ctrl+T",
                );
              }
            }
          }
        }
      },
    );

    it("retains model/thinking before provider and hints and colors the runtime level", () => {
      for (const columns of [20, 32, 48, 80, 120]) {
        terminal.columns = columns;
        chalk.level = 3;
        const output = renderToString(
          createElement(Footer, {
            ...footerProps,
            thinkingLevel: "high",
          }),
          { columns },
        );
        const plain = stripVTControlCharacters(output);
        expect(output).toContain(
          `${colors.hex(thinkingLevelColor("high"))(" ").split(" ")[0]}high`,
        );
        expect(plain).toContain("Plan");
        expect(plain).toContain("20.0%/200k");
        expect(plain).toMatch(/comp.* · high/);
        if (columns < 80) {
          expect(plain).not.toContain("very-long-provider-name");
          expect(plain).not.toContain("Shift+Tab");
        }
        if (columns === 120) {
          expect(plain).toContain(
            "very-long-provider-name/compact-model · high · Plan",
          );
          expect(plain).toContain("Shift+Tab to cycle");
        }
      }
    });

    it("keeps reasoning italic and bounds the expanded streaming tail", () => {
      chalk.level = 3;
      const output = renderToString(
        createElement(ThinkingBlock, {
          text: Array.from(
            { length: 20 },
            (_, index) => `detail-${String(index)}`,
          ).join("\n\n"),
          expanded: true,
          streaming: true,
        }),
        { columns: 40 },
      );
      expect(output).toContain("\u001b[3m");
      const plain = stripVTControlCharacters(output).trim();
      expect(plain).toContain("detail-19");
      expect(plain).not.toContain("detail-0");
      expect(plain.split("\n").length).toBeLessThanOrEqual(6);
      const empty = renderToString(
        createElement(ThinkingBlock, { text: " ", expanded: false }),
        {
          columns: 40,
        },
      );
      expect(empty).toBe("");
    });
  },
);
