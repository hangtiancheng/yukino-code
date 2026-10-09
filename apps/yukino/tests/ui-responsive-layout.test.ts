import { stripVTControlCharacters } from "node:util";

import { Box, Text, render, useInput } from "ink";
import type { Instance, Key } from "ink";
import type * as Ink from "ink";
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AskUserDialog } from "@/ui/ask-user-dialog.js";
import { ChatView } from "@/ui/chat.js";
import type { ChatMessage } from "@/ui/chat.js";
import { CodeReviewDialog } from "@/ui/code-review-dialog.js";
import { Footer } from "@/ui/footer.js";
import type { InputDraft } from "@/ui/input-draft.js";
import { InputBox } from "@/ui/input.js";
import { PermissionDialog } from "@/ui/permission-dialog.js";
import { ProviderLogin } from "@/ui/provider-login.js";
import RewindDialog from "@/ui/rewind-dialog.js";
import { TerminalLayout } from "@/ui/terminal-layout.js";
import { visibleWidth } from "@/ui/terminal-text.js";
import { ToolBlock } from "@/ui/tool-display.js";
import { Transcript } from "@/ui/transcript.js";

const caret = vi.hoisted(() => {
  const state: {
    current: { x: number; y: number } | undefined;
    handlers: Set<(input: string, key: Key) => void>;
  } = {
    current: undefined,
    handlers: new Set(),
  };
  return state;
});
vi.mock("ink", async (importOriginal) => {
  const { useEffect } = await import("react");
  return {
    ...(await importOriginal<typeof Ink>()),
    useInput: vi.fn(
      (
        handler: (input: string, key: Key) => void,
        options?: { isActive?: boolean },
      ) => {
        useEffect(() => {
          if (options?.isActive === false) {
            return;
          }
          caret.handlers.add(handler);
          return () => {
            caret.handlers.delete(handler);
          };
        }, [handler, options?.isActive]);
      },
    ),
    usePaste: vi.fn(),
    useCursor: () => ({
      setCursorPosition: (position: typeof caret.current) => {
        caret.current = position;
      },
    }),
  };
});

const initialColumns = Object.getOwnPropertyDescriptor(
  process.stdout,
  "columns",
);
const initialRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
const footerProps = {
  contextTokens: 40_000,
  contextWindow: 200_000,
  inputTokens: 1250,
  outputTokens: 230,
  model: "compact-model",
  thinkingLevel: "high" as const,
  permissionMode: "plan",
  provider: "very-long-provider-name",
  sessionId: "01234567-89ab-cdef-0123-456789abcdef",
  cwd: "/workspace/日本語/project",
};
let instance: Instance | undefined;
let frame = "";

function resize(columns: number, rows: number) {
  act(() => {
    process.stdout.columns = columns;
    process.stdout.rows = rows;
    process.stdout.emit("resize");
  });
}

function press(key: Partial<Key>, input = "") {
  const handlers = [...caret.handlers];
  vi.mocked(useInput).mockClear();
  act(() => {
    for (const handler of handlers) {
      handler(input, {
        upArrow: false,
        downArrow: false,
        leftArrow: false,
        rightArrow: false,
        pageDown: false,
        pageUp: false,
        home: false,
        end: false,
        return: false,
        escape: false,
        ctrl: false,
        shift: false,
        tab: false,
        backspace: false,
        delete: false,
        meta: false,
        super: false,
        hyper: false,
        capsLock: false,
        numLock: false,
        ...key,
      });
    }
  });
}

function mount(dock: ReactNode, activity: ReactNode = null) {
  act(() => {
    instance = render(
      createElement(TerminalLayout, {
        transcript: null,
        activity,
        status: createElement(Text, {}, "TODO 1/3 · Updating UI"),
        dock,
        footer: createElement(Footer, footerProps),
      }),
      { interactive: false, patchConsole: false, debug: true },
    );
  });
}

function expectFits(columns: number, rows: number) {
  const lines = frame.trimEnd().split("\n");
  expect(lines.length).toBeLessThanOrEqual(rows);
  expect(lines.every((line) => visibleWidth(line) <= columns)).toBe(true);
  if (caret.current) {
    expect(caret.current.x).toBeGreaterThanOrEqual(0);
    expect(caret.current.x).toBeLessThan(columns);
    expect(caret.current.y).toBeGreaterThanOrEqual(0);
    expect(caret.current.y).toBeLessThan(rows);
  }
}

function numberedLines(prefix: string, count: number) {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}-${String(index).padStart(3, "0")}`,
  ).join("\n\n");
}

function terminalScene({
  messages,
  streamingText,
  draftRef,
}: {
  messages: ChatMessage[];
  streamingText?: string;
  draftRef: { current: InputDraft | null };
}) {
  return createElement(TerminalLayout, {
    transcript: createElement(Transcript, {
      messages,
      sessionId: "test-session",
      expanded: false,
      model: "test-model",
      provider: "test-provider",
      cwd: "/workspace/project",
    }),
    activity: createElement(ChatView, { streamingText }),
    status: createElement(Text, {}, "Fixed status"),
    dock: createElement(InputBox, {
      onSubmit: vi.fn(),
      draftRef,
      commands: [
        {
          name: "help",
          description: "Show help",
          type: "local",
          handler: () => "",
        },
      ],
    }),
    footer: createElement(Footer, footerProps),
  });
}

function showScene(scene: ReactNode) {
  act(() => {
    if (instance) {
      instance.rerender(scene);
    } else {
      instance = render(scene, {
        interactive: false,
        patchConsole: false,
        debug: true,
      });
    }
  });
}

function editableDraft(text = "saved draft") {
  return {
    current: {
      lines: [text],
      cursorLine: 0,
      cursorCol: text.length,
      historyIndex: -1,
      historyDraft: null,
    } satisfies InputDraft,
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(useInput).mockClear();
  caret.current = undefined;
  frame = "";
  resize(80, 24);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    const output = stripVTControlCharacters(String(chunk));
    if (output.includes("\n") || output.trim()) {
      frame = output;
    }
    return true;
  });
});

afterEach(() => {
  act(() => {
    instance?.unmount();
    instance?.cleanup();
  });
  instance = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [name, descriptor] of [
    ["columns", initialColumns],
    ["rows", initialRows],
  ] as const) {
    if (descriptor) {
      Object.defineProperty(process.stdout, name, descriptor);
    } else {
      Reflect.deleteProperty(process.stdout, name);
    }
  }
});

describe("terminal conversation history", () => {
  it("prints the entire committed transcript instead of clipping it to terminal height", () => {
    const draftRef = editableDraft();
    const before = structuredClone(draftRef.current);
    const messages: ChatMessage[] = [
      { role: "user", content: "original prompt" },
      { role: "assistant", content: numberedLines("history", 120) },
    ];
    showScene(
      terminalScene({ messages, streamingText: "live output", draftRef }),
    );
    expect(frame).toContain("original prompt");
    expect(frame).toContain("history-000");
    expect(frame).toContain("history-119");
    expect(frame).toContain("live output");
    expect(frame).not.toContain("Jump to latest");
    expect(draftRef.current).toEqual(before);
  });

  it("uses Home/End for the input caret and leaves paging to the terminal", () => {
    const draftRef = editableDraft();
    const messages: ChatMessage[] = [
      { role: "assistant", content: numberedLines("history", 80) },
    ];
    showScene(terminalScene({ messages, draftRef }));
    press({ home: true });
    expect(draftRef.current?.cursorCol).toBe(0);
    press({ end: true });
    expect(draftRef.current?.cursorCol).toBe("saved draft".length);
    const before = structuredClone(draftRef.current);
    press({ pageUp: true });
    press({ pageDown: true });
    expect(draftRef.current).toEqual(before);
    expect(frame).not.toContain("Jump to latest");
  });
});

describe("responsive terminal workspace", () => {
  it("keeps the draft and native caret visible through width and height changes with simultaneous streaming and tools", () => {
    const draftRef: { current: InputDraft | null } = {
      current: {
        lines: ["日本語😁é".repeat(60)],
        cursorLine: 0,
        cursorCol: "日本語😁é".repeat(30).length,
        historyIndex: -1,
        historyDraft: null,
      },
    };
    const before = structuredClone(draftRef.current);
    const activity = createElement(
      Box,
      { flexDirection: "column" },
      createElement(ChatView, {
        streamingText: "Streaming 日本語\n\n".repeat(80),
        thinkingText: "Reasoning\n".repeat(30),
        expanded: true,
      }),
      ...Array.from({ length: 4 }, (_, index) =>
        createElement(ToolBlock, {
          key: index,
          expanded: true,
          tool: {
            toolId: String(index),
            toolName: "Bash",
            args: { command: `task-${String(index)}` },
            loading: true,
            output: Array.from(
              { length: 30 },
              (_, line) => `task-${String(index)}-line-${String(line)}`,
            ).join("\n"),
          },
        }),
      ),
    );
    mount(createElement(InputBox, { onSubmit: vi.fn(), draftRef }), activity);
    for (const [columns, rows] of [
      [80, 24],
      [40, 12],
      [20, 8],
      [20, 5],
      [12, 3],
      [2, 2],
      [1, 1],
      [120, 40],
      [120, 10],
      [80, 24],
    ]) {
      resize(columns, rows);
      expectFits(columns, rows);
      expect(draftRef.current).toEqual(before);
      expect(caret.current).toBeDefined();
      if (rows >= 8) {
        expect(frame).toContain("Plan");
      }
    }
  });

  it("retains the latest live output while making room for a completion list", () => {
    const draftRef: { current: InputDraft | null } = {
      current: {
        lines: ["/"],
        cursorLine: 0,
        cursorCol: 1,
        historyIndex: -1,
        historyDraft: null,
      },
    };
    const commands = Array.from({ length: 30 }, (_, index) => ({
      name: `command-${String(index).padStart(2, "0")}`,
      description: "Choose an action",
      type: "local" as const,
      handler: () => "",
    }));
    mount(
      createElement(InputBox, { onSubmit: vi.fn(), draftRef, commands }),
      createElement(Text, {}, "old line\n".repeat(100) + "latest live output"),
    );
    expectFits(80, 24);
    for (let index = 0; index < 12; index++) {
      press({ downArrow: true });
    }
    expect(frame).toContain("command-12");
    resize(40, 10);
    expectFits(40, 10);
    expect(frame).toContain("command-12");
    resize(80, 40);
    expectFits(80, 40);
    expect(frame).toContain("latest live output");
    expect((frame.match(/old line/g) ?? []).length).toBeLessThan(30);
  });

  it("scrolls permission choices on a short terminal without hiding the selected action", () => {
    resize(32, 6);
    mount(
      createElement(PermissionDialog, {
        toolName: "Bash",
        argsSummary: "long command ".repeat(40),
        reason: "Approval needed",
        onComplete: vi.fn(),
      }),
    );
    press({ downArrow: true });
    press({ downArrow: true });
    expectFits(32, 6);
    expect(frame).toContain("→ No");
  });

  it.each(["provider", "review"])(
    "scrolls the active %s form field into view",
    (form) => {
      resize(32, 8);
      mount(
        form === "provider"
          ? createElement(ProviderLogin, {
              onSubmit: vi.fn(),
              onCancel: vi.fn(),
            })
          : createElement(CodeReviewDialog, {
              onSubmit: vi.fn(),
              onCancel: vi.fn(),
            }),
      );
      for (let index = 0; index < (form === "provider" ? 7 : 4); index++) {
        press({ tab: true });
      }
      expectFits(32, 8);
      expect(frame).toContain(
        form === "provider" ? "› Max out" : "› Exclude globs",
      );
      expect(caret.current).toBeDefined();
      resize(20, 6);
      expectFits(20, 6);
      expect(caret.current).toBeDefined();
      resize(100, 30);
      expectFits(100, 30);
      expect(frame).toContain(
        form === "provider" ? "› Max output tokens" : "› Exclude globs",
      );
    },
  );

  it("keeps the selected question option visible with long questions and narrow tabs", () => {
    resize(32, 8);
    mount(
      createElement(AskUserDialog, {
        questions: Array.from({ length: 3 }, (_, index) => ({
          header: `Question-${String(index)}`,
          question: "A detailed question 日本語 ".repeat(40),
          options: [
            { label: "First", description: "A long description ".repeat(40) },
            { label: "Second" },
          ],
          multiSelect: false,
        })),
        onComplete: vi.fn(),
      }),
    );
    press({ downArrow: true });
    expectFits(32, 8);
    expect(frame).toContain("→ 2. Second");
  });

  it("shows the newest checkpoint in a bounded rewind dialog", () => {
    resize(40, 8);
    mount(
      createElement(RewindDialog, {
        snapshots: Array.from({ length: 80 }, (_, index) => ({
          timestamp: new Date(index * 1000).toISOString(),
          userText: `Checkpoint-${String(index)}`,
          backups: {},
          messageIndex: index,
        })),
        onComplete: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    expectFits(40, 8);
    expect(frame).toContain("Checkpoint-79");
    press({ upArrow: true });
    expect(frame).toContain("Checkpoint-78");
  });

  it("keeps a form's editing caret on the visible draft when only one content row fits", () => {
    resize(32, 5);
    mount(
      createElement(CodeReviewDialog, { onSubmit: vi.fn(), onCancel: vi.fn() }),
    );
    press({}, "visible-draft");
    expectFits(32, 5);
    expect(frame).toContain("visible-draft");
    expect(caret.current).toBeDefined();
    expect(frame.split("\n")[caret.current?.y ?? -1]).toContain(
      "visible-draft",
    );
  });
});
