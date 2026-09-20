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

import type * as fs from "node:fs";
import { stripVTControlCharacters } from "node:util";

import chalk from "chalk";
import { render, renderToString } from "ink";
import type { Instance, Key } from "ink";
import type * as Ink from "ink";
import { act, createElement } from "react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Command } from "@/commands/commands.js";
import { saveClipboardImage } from "@/images/clipboard.js";
import { Footer } from "@/ui/footer.js";
import { InputBox } from "@/ui/input.js";
import type { InputDraft } from "@/ui/input.js";
import { InteractionDock } from "@/ui/interaction-dock.js";
import { StatusBorder } from "@/ui/status-border.js";
import { ICONS, THEME } from "@/ui/styles.js";
import { truncateToWidth, visibleWidth, wrapToLines } from "@/ui/terminal-text.js";

const terminal = vi.hoisted(() => {
  const input: { current: ((text: string, key: Key) => void) | null } = {
    current: null,
  };
  const paste: { current: ((text: string) => void) | null } = { current: null };
  return { columns: 80, rows: 24, files: ["one.ts", "two.ts"], input, paste };
});

// Only replace terminal input and dimensions. All layout is rendered by Ink's
// public renderToString/render APIs; no real CLI, filesystem scan or model runs.
vi.mock("ink", async (importOriginal) => {
  const ink = await importOriginal<typeof Ink>();
  const { useEffect } = await import("react");
  return {
    ...ink,
    useStdout: () => ({
      stdout: { columns: terminal.columns, rows: terminal.rows },
    }),
    useInput: (handler: (text: string, key: Key) => void, options?: { isActive?: boolean }) => {
      useEffect(() => {
        if (options?.isActive === false) {
          return;
        }
        terminal.input.current = handler;
        return () => {
          terminal.input.current = null;
        };
      }, [handler, options?.isActive]);
    },
    usePaste: (handler: (text: string) => void, options?: { isActive?: boolean }) => {
      useEffect(() => {
        if (options?.isActive === false) {
          return;
        }
        terminal.paste.current = handler;
        return () => {
          terminal.paste.current = null;
        };
      }, [handler, options?.isActive]);
    },
  };
});

vi.mock("fs", async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
  readdirSync: () => terminal.files,
  statSync: () => ({ isDirectory: () => false }),
}));

vi.mock("@/images/clipboard.js", () => ({ saveClipboardImage: vi.fn() }));

const commands: Command[] = [
  {
    name: "help",
    aliases: ["h"],
    description: "Show all available commands",
    type: "local",
    handler: () => "",
  },
  {
    name: "model",
    aliases: ["m"],
    description: "Choose the active model [skill]",
    type: "local_ui",
    handler: () => "",
  },
];

const footerProps: ComponentProps<typeof Footer> = {
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
const stats = "↑1.3k ↓230 20.0%/200k";
const initialColorLevel = chalk.level;
let instance: Instance | undefined;

function draftRef(lines = [""], cursorLine = 0, cursorCol = lines[cursorLine].length) {
  const ref: { current: InputDraft | null } = {
    current: {
      lines,
      cursorLine,
      cursorCol,
      historyIndex: -1,
      historyDraft: null,
    },
  };
  return ref;
}

function key(overrides: Partial<Key> = {}): Key {
  return {
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
    ...overrides,
  };
}

function composer(columns: number, props: Partial<ComponentProps<typeof InputBox>> = {}) {
  terminal.columns = columns;
  return renderToString(createElement(InputBox, { onSubmit: vi.fn(), ...props }), { columns });
}

function footer(columns: number, props: Partial<ComponentProps<typeof Footer>> = {}) {
  terminal.columns = columns;
  return stripVTControlCharacters(
    renderToString(createElement(Footer, { ...footerProps, ...props }), {
      columns,
    }),
  );
}

function mount(props: Partial<ComponentProps<typeof InputBox>> = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  act(() => {
    instance = render(createElement(InputBox, { onSubmit: vi.fn(), ...props }), {
      interactive: false,
      patchConsole: false,
    });
  });
}

function unmount() {
  act(() => {
    instance?.unmount();
    instance?.cleanup();
  });
  instance = undefined;
}

function press(text = "", overrides: Partial<Key> = {}) {
  const handler = terminal.input.current;
  if (!handler) {
    throw new Error("Composer input is not active");
  }
  act(() => {
    handler(text, key(overrides));
  });
}

beforeEach(() => {
  terminal.columns = 80;
  terminal.rows = 24;
  terminal.files = ["one.ts", "two.ts"];
  terminal.input.current = null;
  terminal.paste.current = null;
  chalk.level = 0;
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  unmount();
  chalk.level = initialColorLevel;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("composer status borders", () => {
  it("keeps a useful truncated status on narrow terminals", () => {
    const output = renderToString(
      createElement(StatusBorder, {
        width: 24,
        statusLabel: "Retrying: service unavailable",
      }),
      { columns: 24 },
    );
    expect(output).toContain("Retrying:");
    expect(output).toContain("…");
    expect(visibleWidth(output)).toBe(24);
  });
  it.each([1, 2, 3, 4, 5, 8, 12, 20, 28, 40, 80, 100])(
    "uses exactly %i terminal columns even with wide/ANSI status and overflow",
    (width) => {
      for (const statusLabel of [undefined, "\x1b[35m思考 e\u0301\x1b[0m"]) {
        for (const direction of ["up", "down"] satisfies ("up" | "down")[]) {
          const output = renderToString(
            createElement(StatusBorder, {
              width,
              statusLabel,
              hiddenLineCount: 123,
              direction,
            }),
            { columns: width },
          );
          expect(output.split("\n")).toHaveLength(1);
          expect(visibleWidth(output)).toBe(width);
        }
      }
    },
  );

  it("keeps the status left and centers the overflow independently", () => {
    const width = 80;
    const output = renderToString(
      createElement(StatusBorder, {
        width,
        statusLabel: "思考 e\u0301",
        hiddenLineCount: 4,
      }),
      { columns: width },
    );
    expect(output.startsWith("── ⠋ 思考 e\u0301 ")).toBe(true);
    const overflow = " ↑ 4 more ";
    expect(visibleWidth(output.slice(0, output.indexOf(overflow)))).toBe(
      Math.floor((width - visibleWidth(overflow)) / 2),
    );
  });

  it("falls back to a spinner to leave the overflow centered", () => {
    const output = renderToString(
      createElement(StatusBorder, {
        width: 30,
        statusLabel: "A status too long to share the border",
        hiddenLineCount: 3,
      }),
      { columns: 30 },
    );
    expect(output.startsWith("── ⠋ ")).toBe(true);
    expect(output).not.toContain("A status");
    expect(output.indexOf(" ↑ 3 more ")).toBe(10);
  });

  it("centers lower overflow without inventing a status", () => {
    const output = renderToString(
      createElement(StatusBorder, {
        width: 40,
        direction: "down",
        hiddenLineCount: 5,
      }),
      { columns: 40 },
    );
    expect(output.indexOf(" ↓ 5 more ")).toBe(15);
    expect(output).not.toContain("⠋");
  });

  it("uses both borders in InputBox and removes its duplicate permission row", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${String(index)}`);
    const output = composer(60, {
      draftRef: draftRef(lines, 10),
      statusLabel: "Thinking",
      permMode: "acceptEdits",
    }).split("\n");
    expect(output).toHaveLength(9);
    expect(output[0]).toContain("── ⠋ Thinking ");
    expect(output[0]).toContain(" ↑ 7 more ");
    expect(output.at(-1)).toContain(" ↓ 6 more ");
    expect(visibleWidth(output[0])).toBe(60);
    expect(visibleWidth(output.at(-1) ?? "")).toBe(60);
    expect(output.join("\n")).not.toMatch(/Accept Edits|Shift\+Tab/);
  });

  it.each([1, 2, 4, 7])("does not impose an eight-column minimum at width %i", (width) => {
    const output = composer(width).split("\n");
    expect(visibleWidth(output[0])).toBe(width);
    expect(visibleWidth(output.at(-1) ?? "")).toBe(width);
    expect(output.every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it("preserves the inverse cursor in the input body", () => {
    chalk.level = 3;
    const output = composer(30, { draftRef: draftRef(["abc"], 0, 1) });
    expect(output).toContain("\x1b[7mb\x1b[27m");
    expect(stripVTControlCharacters(output)).toContain("abc");
  });
});

describe("composer completion rows", () => {
  it("dismisses @ completion without deleting the draft or moving the caret", () => {
    const ref = draftRef(["check @one"]);
    const onEscape = vi.fn();
    mount({ draftRef: ref, onEscape });
    press("", { escape: true });
    expect(ref.current?.lines).toEqual(["check @one"]);
    expect(ref.current?.cursorCol).toBe(10);
    expect(onEscape).not.toHaveBeenCalled();
    press("", { escape: true });
    expect(onEscape).toHaveBeenCalledOnce();
    press("!");
    expect(ref.current?.lines).toEqual(["check @one!"]);
  });

  it("completes the @ token at the caret and preserves the rest of the line", () => {
    const ref = draftRef(["check @one please"], 0, 10);
    mount({ draftRef: ref });
    press("", { tab: true });
    expect(ref.current?.lines).toEqual(["check @one.ts please"]);
    expect(ref.current?.cursorCol).toBe(14);
  });

  it("submits a dismissed @ mention unchanged", () => {
    const ref = draftRef(["@one"]);
    const onSubmit = vi.fn();
    mount({ draftRef: ref, onSubmit });
    press("", { escape: true });
    press("", { return: true });
    expect(onSubmit).toHaveBeenCalledWith("@one");
  });
  it("hides descriptions and skill tags on narrow slash lists", () => {
    const narrow = composer(30, { commands, draftRef: draftRef(["/"]) });
    expect(narrow).toContain(`${ICONS.arrow} /help`);
    expect(narrow).toContain("/model");
    expect(narrow).not.toContain("Show all");
    expect(narrow).not.toContain("[skill]");
    const wide = composer(80, { commands, draftRef: draftRef(["/"]) });
    expect(wide).toContain("Show all available commands");
    expect(wide).toContain("Choose the active model [skill]");
  });

  it("keeps long wide-character command names in a single row", () => {
    const longCommand: Command = {
      ...commands[0],
      name: "很长的命令名称".repeat(4),
    };
    const output = composer(18, {
      commands: [longCommand],
      draftRef: draftRef(["/"]),
    });
    expect(output.split("\n")).toHaveLength(5);
    expect(output.split("\n").every((line) => visibleWidth(line) <= 18)).toBe(true);
    expect(output).toContain("…");
  });

  it("paints a full-width selected @file row and aligns its arrow with slash rows", () => {
    chalk.level = 3;
    const output = composer(30, {
      workDir: "/virtual",
      draftRef: draftRef(["@"]),
    });
    const row = output.split("\n").find((line) => line.includes("@one.ts")) ?? "";
    expect(stripVTControlCharacters(row).startsWith(` ${ICONS.arrow} @one.ts`)).toBe(true);
    expect(visibleWidth(row)).toBe(30);
    const background = chalk.bgHex(THEME.selectedBg)(" ").split(" ")[0];
    expect(row.startsWith(background)).toBe(true);
    expect(row).toContain("\x1b[49m");
  });

  it("clips long @file suggestions to one row", () => {
    terminal.files = ["很长的文件路径/".repeat(8) + "file.ts"];
    const output = composer(20, {
      workDir: "/virtual",
      draftRef: draftRef(["@"]),
    });
    expect(output.split("\n")).toHaveLength(5);
    expect(output.split("\n").every((line) => visibleWidth(line) <= 20)).toBe(true);
  });
});

describe("composer queue recall and visual navigation", () => {
  it("falls back to history when the queue is empty and restores the clean draft", () => {
    const ref = draftRef();
    const onRecallQueuedMessage = vi.fn(() => undefined);
    mount({
      draftRef: ref,
      history: ["older", "newer"],
      onRecallQueuedMessage,
    });
    press("", { upArrow: true });
    expect(onRecallQueuedMessage).toHaveBeenCalledOnce();
    expect(ref.current?.lines).toEqual(["newer"]);
    press("", { upArrow: true });
    expect(ref.current?.lines).toEqual(["older"]);
    expect(onRecallQueuedMessage).toHaveBeenCalledOnce();
    press("", { downArrow: true });
    press("", { downArrow: true });
    expect(ref.current).toEqual(draftRef().current);
  });

  it("leaves an empty draft intact when neither queue nor history has an entry", () => {
    const ref = draftRef();
    const onRecallQueuedMessage = vi.fn(() => undefined);
    mount({ draftRef: ref, onRecallQueuedMessage });
    press("", { downArrow: true });
    expect(onRecallQueuedMessage).not.toHaveBeenCalled();
    press("", { upArrow: true });
    expect(onRecallQueuedMessage).toHaveBeenCalledOnce();
    expect(ref.current).toEqual(draftRef().current);
  });

  it("does not recall while browsing even an empty history entry", () => {
    const ref = draftRef();
    const onRecallQueuedMessage = vi.fn(() => undefined);
    mount({ draftRef: ref, history: [""], onRecallQueuedMessage });
    press("", { upArrow: true });
    press("", { upArrow: true });
    expect(ref.current?.historyIndex).toBe(0);
    expect(onRecallQueuedMessage).toHaveBeenCalledOnce();
  });

  it.each([["draft"], [" "], ["first", "second"], ["", ""]])(
    "never pops the queue from an existing draft %j",
    (...lines) => {
      const ref = draftRef(lines);
      const onRecallQueuedMessage = vi.fn(() => "queued");
      mount({ draftRef: ref, onRecallQueuedMessage });
      press("", { upArrow: true });
      press("", { downArrow: true });
      expect(onRecallQueuedMessage).not.toHaveBeenCalled();
      expect(ref.current?.lines).toEqual(lines);
    },
  );

  it("atomically recalls only once when two Up events arrive before React renders", () => {
    const queue = ["older", "newest"];
    const onRecallQueuedMessage = vi.fn(() => queue.pop());
    const onSubmit = vi.fn();
    const ref = draftRef();
    mount({ draftRef: ref, onRecallQueuedMessage, onSubmit });
    act(() => {
      terminal.input.current?.("", key({ upArrow: true }));
      terminal.input.current?.("", key({ upArrow: true }));
    });
    expect(onRecallQueuedMessage).toHaveBeenCalledOnce();
    expect(queue).toEqual(["older"]);
    expect(ref.current?.lines).toEqual(["newest"]);
    expect(ref.current?.cursorCol).toBe(6);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("recalls full editable multiline text, persists it, and submits the edit exactly once", () => {
    const text = `first\n${"x".repeat(1100)}`;
    const ref = draftRef();
    const onSubmit = vi.fn();
    const onRecallQueuedMessage = vi.fn(() => text);
    mount({ draftRef: ref, onRecallQueuedMessage, onSubmit });
    press("", { upArrow: true });
    expect(ref.current?.lines).toEqual(text.split("\n"));
    expect(ref.current?.cursorLine).toBe(1);
    expect(ref.current?.cursorCol).toBe(1100);
    expect(ref.current?.pastes).toBeUndefined();
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
    mount({ draftRef: ref, onRecallQueuedMessage, onSubmit });
    press("", { backspace: true });
    press("!");
    act(() => {
      terminal.input.current?.("\r", key({ return: true }));
      terminal.input.current?.("\r", key({ return: true }));
    });
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(`first\n${"x".repeat(1099)}!`);
    expect(onRecallQueuedMessage).toHaveBeenCalledOnce();
  });

  it("drops stale paste payloads on recall and does not activate recalled completion text", () => {
    const ref = draftRef();
    const onSubmit = vi.fn();
    const recalled = "@one [paste #1 1001 chars]";
    mount({ draftRef: ref, onSubmit, onRecallQueuedMessage: () => recalled });
    act(() => {
      terminal.paste.current?.("x".repeat(1001));
    });
    press("", { backspace: true });
    expect(ref.current?.lines).toEqual([""]);
    expect(ref.current?.pastes).toBeDefined();
    press("", { upArrow: true });
    expect(ref.current?.pastes).toBeUndefined();
    expect(ref.current?.historyDraft).toBeNull();
    press("", { return: true });
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(recalled);
  });

  it("invalidates an in-flight clipboard image when recalling a queued draft", async () => {
    type ClipboardResult = Awaited<ReturnType<typeof saveClipboardImage>>;
    let resolve: ((result: ClipboardResult) => void) | undefined;
    const pending = new Promise<ClipboardResult>((complete) => {
      resolve = complete;
    });
    vi.mocked(saveClipboardImage).mockReturnValue(pending);
    const ref = draftRef();
    const onSubmit = vi.fn();
    mount({
      draftRef: ref,
      onSubmit,
      onRecallQueuedMessage: () => "queued",
      workDir: "/virtual",
    });
    act(() => {
      terminal.paste.current?.("");
    });
    press("", { upArrow: true });
    await act(async () => {
      resolve?.({ ok: true, value: "/virtual/image.png" });
      await pending;
    });
    expect(ref.current?.lines).toEqual(["queued"]);
    expect(ref.current?.pastes).toBeUndefined();
    press("", { return: true });
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("queued");
  });

  it.each(["/help", "@one"])("submits recalled %s literally rather than completing it", (text) => {
    const ref = draftRef();
    const onSubmit = vi.fn();
    mount({
      draftRef: ref,
      commands,
      onSubmit,
      onRecallQueuedMessage: () => text,
    });
    press("", { upArrow: true });
    press("", { return: true });
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(text);
  });

  it("prioritizes slash completion over a soft-wrapped row and history", () => {
    terminal.columns = 3;
    const ref = draftRef(["/"]);
    const onRecallQueuedMessage = vi.fn(() => "queued");
    mount({
      draftRef: ref,
      commands,
      history: ["history"],
      onRecallQueuedMessage,
    });
    press("", { upArrow: true });
    expect(ref.current?.cursorCol).toBe(1);
    expect(ref.current?.lines).toEqual(["/"]);
    press("", { return: true });
    expect(ref.current?.lines).toEqual(["/model "]);
    expect(onRecallQueuedMessage).not.toHaveBeenCalled();
  });

  it("prioritizes @file completion over movement in multiline input", () => {
    const ref = draftRef(["first", "@"], 1);
    const onRecallQueuedMessage = vi.fn(() => "queued");
    mount({ draftRef: ref, onRecallQueuedMessage });
    press("", { upArrow: true });
    expect(ref.current?.cursorLine).toBe(1);
    expect(ref.current?.cursorCol).toBe(1);
    press("", { tab: true });
    expect(ref.current?.lines).toEqual(["first", "@two.ts "]);
    expect(onRecallQueuedMessage).not.toHaveBeenCalled();
  });

  it("retains the preferred column across rapid Up/Down and leaves multiline boundaries intact", () => {
    const lines = ["abcdef", "x", "abcdef"];
    const ref = draftRef(lines, 2, 5);
    const onRecallQueuedMessage = vi.fn(() => "queued");
    mount({ draftRef: ref, history: ["history"], onRecallQueuedMessage });
    act(() => {
      terminal.input.current?.("", key({ upArrow: true }));
      expect(ref.current?.cursorCol).toBe(1);
      terminal.input.current?.("", key({ upArrow: true }));
      expect(ref.current?.cursorCol).toBe(5);
      terminal.input.current?.("", key({ upArrow: true }));
    });
    expect(ref.current?.cursorLine).toBe(0);
    expect(ref.current?.lines).toEqual(lines);
    press("", { downArrow: true });
    expect(ref.current?.cursorCol).toBe(1);
    press("", { downArrow: true });
    expect(ref.current?.cursorCol).toBe(5);
    press("", { downArrow: true });
    expect(ref.current?.cursorLine).toBe(2);
    expect(ref.current?.cursorCol).toBe(5);
    expect(ref.current?.historyIndex).toBe(-1);
    expect(onRecallQueuedMessage).not.toHaveBeenCalled();
  });

  it.each(["horizontal", "edit", "paste", "insert"])(
    "resets the vertical goal after a %s action",
    (action) => {
      const ref = draftRef(["abcdef", "x", "abcdef"], 2, 5);
      const insertTextRef: { current: ((text: string) => void) | null } = {
        current: null,
      };
      mount({ draftRef: ref, insertTextRef });
      press("", { upArrow: true });
      if (action === "horizontal") {
        press("", { leftArrow: true });
      } else if (action === "edit") {
        press("!");
      } else if (action === "paste") {
        act(() => {
          terminal.paste.current?.("!");
        });
      } else {
        act(() => {
          insertTextRef.current?.("!");
        });
      }
      const editedColumn = ref.current?.cursorCol;
      press("", { upArrow: true });
      expect(ref.current?.cursorCol).toBe(editedColumn);
      expect(ref.current?.cursorCol).not.toBe(5);
    },
  );

  it("moves between soft wraps before browsing history and restores the saved long draft", () => {
    terminal.columns = 6;
    const ref = draftRef(["abcdefghi"]);
    const onRecallQueuedMessage = vi.fn(() => "queued");
    mount({ draftRef: ref, history: ["old"], onRecallQueuedMessage });
    press("", { upArrow: true });
    expect(ref.current?.cursorCol).toBe(5);
    press("", { upArrow: true });
    expect(ref.current?.cursorCol).toBe(1);
    press("", { upArrow: true });
    expect(ref.current?.lines).toEqual(["old"]);
    press("", { downArrow: true });
    expect(ref.current?.lines).toEqual(["abcdefghi"]);
    expect(ref.current?.cursorCol).toBe(1);
    press("", { downArrow: true });
    expect(ref.current?.cursorCol).toBe(5);
    expect(onRecallQueuedMessage).not.toHaveBeenCalled();
  });

  it("reflows at narrow resize and resets the preferred display column", () => {
    const ref = draftRef(["abcdefghijk", "x", "abcdefghijk"], 2, 9);
    const props = { draftRef: ref, onSubmit: vi.fn() };
    mount(props);
    press("", { upArrow: true });
    expect(ref.current?.cursorCol).toBe(1);
    terminal.columns = 6;
    act(() => {
      instance?.rerender(createElement(InputBox, props));
    });
    press("", { upArrow: true });
    expect(ref.current?.cursorLine).toBe(0);
    expect(ref.current?.cursorCol).toBe(9);
    press("", { upArrow: true });
    expect(ref.current?.cursorCol).toBe(5);
    terminal.columns = 1;
    act(() => {
      instance?.rerender(createElement(InputBox, props));
    });
    press("", { downArrow: true });
    expect(ref.current?.cursorCol).toBe(6);
    expect(ref.current?.lines).toEqual(["abcdefghijk", "x", "abcdefghijk"]);
  });

  it.each([1, 20, 40, 80])("bounds the visual viewport and inverse caret at width %i", (width) => {
    chalk.level = 3;
    const line = "界👩‍💻é".repeat(200);
    const ref = draftRef([line], 0, "界👩‍💻é".repeat(100).length);
    const output = composer(width, { draftRef: ref });
    const rows = output.split("\n");
    expect(rows).toHaveLength(9);
    expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
    expect(output).toContain("\x1b[7m");
    expect(ref.current?.lines).toEqual([line]);
    if (width > 1) {
      expect(output).toContain("\x1b[7m界\x1b[27m");
      expect(rows[0]).toContain("more");
      expect(rows.at(-1)).toContain("more");
    }
  });
});

describe("footer priorities", () => {
  it("shows provider, model, mode and the cycle hint when there is room", () => {
    const output = footer(150);
    expect(output.split("\n")).toHaveLength(2);
    expect(output).toContain(stats);
    expect(output).toContain("very-long-provider-name/compact-model · Plan  Shift+Tab to cycle");
    expect(output).toContain(footerProps.sessionId);
  });

  it("drops the hint and provider before shortening the model with a two-column gap", () => {
    const width = visibleWidth(stats) + 2 + visibleWidth("compact-model · Plan") + 2;
    const line = footer(width).split("\n").at(-1) ?? "";
    expect(line.trim()).toBe(`${stats}  compact-model · Plan`);
    expect(line).not.toContain("provider");
    expect(line).not.toContain("Shift+Tab");
    const narrower =
      footer(width - 5)
        .split("\n")
        .at(-1) ?? "";
    expect(narrower.trim()).toBe(`${stats}  ${truncateToWidth("compact-model", 8)} · Plan`);
  });

  it("only truncates cwd and keeps the complete session ID on the first row when possible", () => {
    const output = footer(70, { workDir: "/工作目录/".repeat(20) });
    const first = output.split("\n")[0];
    expect(first).toContain("…");
    expect(first.trimEnd().endsWith(footerProps.sessionId)).toBe(true);
    expect(visibleWidth(first)).toBeLessThanOrEqual(70);
  });

  it("gives the complete session ID its own wrapped rows on tiny terminals", () => {
    const output = footer(16).split("\n");
    const sessionRows = wrapToLines(footerProps.sessionId, 14);
    expect(output.slice(1, sessionRows.length + 1).map((line) => line.trim())).toEqual(sessionRows);
    expect(
      output
        .slice(1, sessionRows.length + 1)
        .map((line) => line.trim())
        .join(""),
    ).toBe(footerProps.sessionId);
    expect(output.join("\n")).toContain("Plan");
  });

  it.each([1, 2, 3, 8, 16, 24, 40, 80, 120])("never overflows a %i-column terminal", (width) => {
    const output = footer(width, {
      model: "模型-".repeat(30),
      permissionMode: "acceptEdits",
      workDir: "/工作区/项目/".repeat(10),
    });
    expect(output.split("\n").every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it.each([
    ["default", "Default"],
    ["acceptEdits", "Accept Edits"],
    ["plan", "Plan"],
    ["bypassPermissions", "YOLO"],
  ])("keeps %s mode identifiable on a narrow footer", (permissionMode, label) => {
    expect(footer(24, { permissionMode })).toContain(label);
  });

  it("preserves the existing token rounding and zero-context semantics", () => {
    const output = footer(150, {
      inputTokens: 1_250_000,
      outputTokens: 12_500,
      contextWindow: 0,
    });
    expect(output).toContain("↑1.3M ↓13k 0.0%/0");
  });
});

describe("persistent composer drafts and input behavior", () => {
  it("restores the dock-owned draft and caret after a provider selector closes", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const view = (selecting: boolean) =>
      createElement(InteractionDock, {
        composer: { onSubmit },
        provider: selecting
          ? {
              providers: [
                {
                  name: "local",
                  protocol: "openai-compat",
                  base_url: "http://localhost",
                  model: "local",
                },
              ],
              onSelect: vi.fn(),
              onCancel,
            }
          : undefined,
      });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    act(() => {
      instance = render(view(false), {
        interactive: false,
        patchConsole: false,
      });
    });
    press("draft");
    press("", { leftArrow: true });
    act(() => {
      instance?.rerender(view(true));
    });
    expect(terminal.paste.current).toBeNull();
    press("", { escape: true });
    expect(onCancel).toHaveBeenCalledOnce();
    act(() => {
      instance?.rerender(view(false));
    });
    expect(terminal.paste.current).not.toBeNull();
    press("!");
    press("\r", { return: true });
    expect(onSubmit).toHaveBeenCalledWith("draf!t");
  });
  it("restores multiline content and cursor, preserving editing and newline behavior", () => {
    const ref = draftRef(["first", "second"], 1, 3);
    mount({ draftRef: ref });
    press("X");
    expect(ref.current?.lines).toEqual(["first", "secXond"]);
    press("", { leftArrow: true });
    press("", { backspace: true });
    expect(ref.current?.lines).toEqual(["first", "seXond"]);
    press("", { return: true, shift: true });
    expect(ref.current?.lines).toEqual(["first", "se", "Xond"]);
    expect(ref.current?.cursorLine).toBe(2);
    expect(ref.current?.cursorCol).toBe(0);
  });

  it("moves and deletes complete grapheme clusters", () => {
    const ref = draftRef(["a👩‍💻éb"]);
    mount({ draftRef: ref });

    press("", { leftArrow: true });
    expect(ref.current?.cursorCol).toBe("a👩‍💻é".length);
    press("", { leftArrow: true });
    expect(ref.current?.cursorCol).toBe("a👩‍💻".length);
    press("", { backspace: true });
    expect(ref.current?.lines).toEqual(["aéb"]);
    expect(ref.current?.cursorCol).toBe(1);

    press("", { delete: true });
    expect(ref.current?.lines).toEqual(["ab"]);
    expect(ref.current?.cursorCol).toBe(1);
  });

  it("persists before an event can unmount the input and leaves no hidden input hook", () => {
    const ref: { current: InputDraft | null } = { current: null };
    mount({ draftRef: ref });
    act(() => {
      terminal.input.current?.("unsent", key());
      expect(ref.current?.lines).toEqual(["unsent"]);
      expect(ref.current?.cursorCol).toBe(6);
      instance?.unmount();
      instance?.cleanup();
    });
    instance = undefined;
    expect(terminal.input.current).toBeNull();
    expect(terminal.paste.current).toBeNull();
    mount({ draftRef: ref });
    press("!");
    expect(ref.current?.lines).toEqual(["unsent!"]);
  });

  it("restores history position and the original unsent draft after a selector remount", () => {
    const ref = draftRef(["draft"], 0, 3);
    const history = ["older", "newer"];
    mount({ draftRef: ref, history });
    press("", { upArrow: true });
    press("", { upArrow: true });
    expect(ref.current?.lines).toEqual(["older"]);
    expect(ref.current?.historyIndex).toBe(1);
    unmount();
    mount({ draftRef: ref, history });
    press("", { downArrow: true });
    expect(ref.current?.lines).toEqual(["newer"]);
    press("", { downArrow: true });
    expect(ref.current).toEqual({
      lines: ["draft"],
      cursorLine: 0,
      cursorCol: 3,
      historyIndex: -1,
      historyDraft: null,
    });
  });

  it("saves imperative insertion before unmount and clears the saved draft via clearRef", () => {
    const ref = draftRef(["hello"]);
    const insertTextRef: { current: ((text: string) => void) | null } = {
      current: null,
    };
    const clearRef: { current: (() => void) | null } = { current: null };
    mount({ draftRef: ref, insertTextRef, clearRef });
    act(() => {
      insertTextRef.current?.("@file");
      instance?.unmount();
      instance?.cleanup();
    });
    instance = undefined;
    expect(ref.current?.lines).toEqual(["hello @file"]);
    expect(ref.current?.cursorCol).toBe(11);
    expect(insertTextRef.current).toBeNull();
    expect(clearRef.current).toBeNull();
    mount({ draftRef: ref, clearRef });
    act(() => {
      clearRef.current?.();
    });
    expect(ref.current).toEqual(draftRef().current);
  });

  it("normalizes bracketed and plain multiline pastes without submitting", () => {
    const ref = draftRef();
    const onSubmit = vi.fn();
    mount({ draftRef: ref, onSubmit });
    act(() => {
      terminal.paste.current?.("first\r\nsecond\rthird");
    });
    expect(ref.current?.lines).toEqual(["first", "second", "third"]);
    press("\nlast");
    expect(ref.current?.lines).toEqual(["first", "second", "third", "last"]);
    expect(ref.current?.cursorLine).toBe(3);
    expect(ref.current?.cursorCol).toBe(4);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("collapses a clipboard image and submits the existing quoted @file mention", async () => {
    vi.mocked(saveClipboardImage).mockResolvedValue({
      ok: true,
      value: "/virtual/image.png",
    });
    const ref = draftRef(["hello"]);
    const onSubmit = vi.fn();
    mount({
      draftRef: ref,
      onSubmit,
      workDir: "/virtual",
      sessionId: "session",
    });
    await act(async () => {
      terminal.paste.current?.("");
      await Promise.resolve();
    });
    expect(ref.current?.lines).toEqual(["hello [Image #1] "]);
    expect(saveClipboardImage).toHaveBeenLastCalledWith("/virtual", "session");
    press("\r", { return: true });
    expect(onSubmit).toHaveBeenCalledWith("hello '@image.png'");
  });

  it("collapses 124 pasted lines to the PI marker and preserves the payload across remounts", () => {
    const text = Array.from({ length: 124 }, (_, i) => `line ${String(i + 1)}`).join("\n");
    const ref = draftRef(["Review: "]);
    const onSubmit = vi.fn();
    mount({ draftRef: ref, onSubmit });
    act(() => {
      terminal.paste.current?.(text);
    });
    expect(ref.current?.lines).toEqual(["Review: [paste #1 +124 lines]"]);
    unmount();
    const output = stripVTControlCharacters(composer(80, { draftRef: ref }));
    expect(output).toContain("[paste #1 +124 lines]");
    expect(output).not.toContain("line 124");
    expect(output.split("\n")).toHaveLength(3);
    mount({ draftRef: ref, onSubmit });
    press(" please");
    press("\r", { return: true });
    expect(onSubmit).toHaveBeenCalledWith(`Review: ${text} please`);
  });

  it("numbers successive large pastes, and moves or deletes each as a whole", () => {
    const ref = draftRef();
    const onSubmit = vi.fn();
    mount({ draftRef: ref, onSubmit });
    act(() => {
      // Both events can arrive before React renders again.
      terminal.paste.current?.("x".repeat(1001));
      terminal.paste.current?.("y".repeat(1002));
    });
    const first = "[paste #1 1001 chars]";
    expect(ref.current?.lines).toEqual([`${first}[paste #2 1002 chars]`]);
    press("", { leftArrow: true });
    expect(ref.current?.cursorCol).toBe(first.length);
    press("", { rightArrow: true });
    expect(ref.current?.cursorCol).toBe(first.length + "[paste #2 1002 chars]".length);
    press("", { backspace: true });
    expect(ref.current?.lines).toEqual([first]);
    press("", { leftArrow: true });
    press("", { delete: true });
    expect(ref.current?.lines).toEqual([""]);
    press("ok");
    press("\r", { return: true });
    expect(onSubmit).toHaveBeenCalledWith("ok");
  });

  it("submits the latest paste even when Enter arrives before the next render", () => {
    const ref = draftRef();
    const onSubmit = vi.fn();
    const text = "x".repeat(1001);
    mount({ draftRef: ref, onSubmit });
    act(() => {
      terminal.paste.current?.(text);
      terminal.input.current?.("!", key());
      terminal.input.current?.("\r", key({ return: true }));
    });
    expect(onSubmit).toHaveBeenCalledWith(`${text}!`);
  });

  it("retains pasted drafts during history browsing without expanding literal history markers", () => {
    const ref = draftRef();
    const onSubmit = vi.fn();
    const history = ["[paste #1 1001 chars]"];
    mount({ draftRef: ref, onSubmit, history });
    act(() => {
      terminal.paste.current?.("x".repeat(1001));
    });
    press("", { upArrow: true });
    expect(ref.current?.pastes).toBeUndefined();
    press("", { downArrow: true });
    expect(ref.current?.pastes).toBeDefined();
    press("\r", { return: true });
    expect(onSubmit).toHaveBeenLastCalledWith("x".repeat(1001));
    press("", { upArrow: true });
    press("\r", { return: true });
    expect(onSubmit).toHaveBeenLastCalledWith("[paste #1 1001 chars]");
  });

  it("uses a single expansion pass for literal markers inside a pasted payload", () => {
    const ref = draftRef();
    const onSubmit = vi.fn();
    const first = `${"x".repeat(1001)}[paste #2 1002 chars]`;
    mount({ draftRef: ref, onSubmit });
    act(() => {
      terminal.paste.current?.(first);
    });
    press(" ");
    act(() => {
      terminal.paste.current?.("y".repeat(1002));
    });
    press("\r", { return: true });
    expect(onSubmit).toHaveBeenCalledWith(`${first} ${"y".repeat(1002)}`);
  });

  it("numbers images independently, restores them with the draft, and resets after clear", async () => {
    vi.mocked(saveClipboardImage).mockResolvedValue({
      ok: true,
      value: "/virtual/image.png",
    });
    const ref = draftRef();
    const onSubmit = vi.fn();
    const clearRef: { current: (() => void) | null } = { current: null };
    mount({ draftRef: ref, onSubmit, clearRef, workDir: "/virtual" });
    act(() => {
      terminal.paste.current?.("x".repeat(1001));
    });
    await act(async () => {
      terminal.paste.current?.("");
      await Promise.resolve();
    });
    await act(async () => {
      terminal.paste.current?.("");
      await Promise.resolve();
    });
    expect(ref.current?.lines).toEqual(["[paste #1 1001 chars] [Image #1] [Image #2] "]);
    unmount();
    mount({ draftRef: ref, onSubmit, clearRef, workDir: "/virtual" });
    press("", { leftArrow: true });
    press("", { backspace: true });
    expect(ref.current?.lines[0]).not.toContain("[Image #2]");
    press("\r", { return: true });
    expect(onSubmit).toHaveBeenCalledWith(`${"x".repeat(1001)} '@image.png'`);
    await act(async () => {
      terminal.paste.current?.("");
      await Promise.resolve();
    });
    expect(ref.current?.lines).toEqual(["[Image #1] "]);
    act(() => {
      clearRef.current?.();
    });
    expect(ref.current?.pastes).toBeUndefined();
  });

  it("ignores a late image paste from the input replaced by a selector", async () => {
    type ClipboardResult = Awaited<ReturnType<typeof saveClipboardImage>>;
    let resolve: ((result: ClipboardResult) => void) | undefined;
    const pending = new Promise<ClipboardResult>((complete) => {
      resolve = complete;
    });
    vi.mocked(saveClipboardImage).mockReturnValue(pending);
    const ref = draftRef(["draft"]);
    mount({ draftRef: ref, workDir: "/virtual" });
    act(() => {
      terminal.paste.current?.("");
    });
    unmount();
    mount({ draftRef: ref, workDir: "/virtual" });
    press("!");
    await act(async () => {
      resolve?.({ ok: true, value: "/virtual/image.png" });
      await pending;
    });
    expect(ref.current?.lines).toEqual(["draft!"]);
  });

  it("invalidates an in-flight clipboard image when the draft is cleared", async () => {
    type ClipboardResult = Awaited<ReturnType<typeof saveClipboardImage>>;
    let resolve: ((result: ClipboardResult) => void) | undefined;
    const pending = new Promise<ClipboardResult>((complete) => {
      resolve = complete;
    });
    vi.mocked(saveClipboardImage).mockReturnValue(pending);
    const ref = draftRef(["draft"]);
    const clearRef: { current: (() => void) | null } = { current: null };
    mount({ draftRef: ref, clearRef, workDir: "/virtual" });
    act(() => {
      terminal.paste.current?.("");
    });
    act(() => {
      clearRef.current?.();
    });
    press("new draft");
    await act(async () => {
      resolve?.({ ok: true, value: "/virtual/image.png" });
      await pending;
    });
    expect(ref.current?.lines).toEqual(["new draft"]);
    expect(ref.current?.pastes).toBeUndefined();
  });

  it("waits for the clipboard image before allowing submission", async () => {
    type ClipboardResult = Awaited<ReturnType<typeof saveClipboardImage>>;
    let resolve: ((result: ClipboardResult) => void) | undefined;
    const pending = new Promise<ClipboardResult>((complete) => {
      resolve = complete;
    });
    vi.mocked(saveClipboardImage).mockReturnValue(pending);
    const ref = draftRef(["Describe"]);
    const onSubmit = vi.fn();
    mount({ draftRef: ref, onSubmit, workDir: "/virtual" });
    act(() => {
      terminal.paste.current?.("");
    });
    press("\r", { return: true });
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => {
      resolve?.({ ok: true, value: "/virtual/image.png" });
      await pending;
    });
    press("\r", { return: true });
    expect(onSubmit).toHaveBeenCalledWith("Describe '@image.png'");
  });

  it("returns from multiline history to the original pasted draft", () => {
    const ref = draftRef();
    const onSubmit = vi.fn();
    mount({ draftRef: ref, onSubmit, history: ["first\nsecond"] });
    act(() => {
      terminal.paste.current?.("x".repeat(1001));
    });
    press("", { upArrow: true });
    press("", { downArrow: true });
    press("", { downArrow: true });
    expect(ref.current?.lines).toEqual(["[paste #1 1001 chars]"]);
    press("\r", { return: true });
    expect(onSubmit).toHaveBeenCalledWith("x".repeat(1001));
  });

  it("keeps Enter-to-complete separate from Enter-to-submit for slash and @file", () => {
    const ref = draftRef();
    const onSubmit = vi.fn();
    mount({ draftRef: ref, onSubmit, commands, workDir: "/virtual" });
    press("/");
    press("", { downArrow: true });
    press("", { return: true });
    expect(ref.current?.lines).toEqual(["/model "]);
    expect(onSubmit).not.toHaveBeenCalled();
    press("", { return: true });
    expect(onSubmit).toHaveBeenLastCalledWith("/model");
    expect(ref.current).toEqual(draftRef().current);
    press("@");
    press("", { return: true });
    expect(ref.current?.lines).toEqual(["@one.ts "]);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    press("", { return: true });
    expect(onSubmit).toHaveBeenLastCalledWith("@one.ts");
    expect(ref.current).toEqual(draftRef().current);
  });

  it.each(["thinking", "think"])(
    "completes supported /%s levels and submits the bare command",
    (name) => {
      const ref = draftRef();
      const onSubmit = vi.fn();
      mount({
        draftRef: ref,
        onSubmit,
        commands: [
          {
            name: "thinking",
            aliases: ["think"],
            type: "local",
            description: "Thinking level",
            handler: () => "",
          },
        ],
        thinkingLevels: ["off", "high"],
      });
      press(`/${name}`);
      press("", { return: true });
      expect(onSubmit).toHaveBeenLastCalledWith(`/${name}`);
      press(`/${name} h`);
      press("", { tab: true });
      expect(ref.current?.lines).toEqual([`/${name} high `]);
      press("", { return: true });
      expect(onSubmit).toHaveBeenLastCalledWith(`/${name} high`);
      press(`/${name} low`);
      press("", { tab: true });
      expect(ref.current?.lines).toEqual([`/${name} low`]);
    },
  );

  it("retains Tab completion and Shift+Tab mode cycling", () => {
    const ref = draftRef();
    const onModeChange = vi.fn();
    mount({ draftRef: ref, commands, onModeChange, workDir: "/virtual" });
    press("/h");
    press("", { tab: true });
    expect(ref.current?.lines).toEqual(["/help "]);
    press("", { tab: true, shift: true });
    expect(onModeChange).toHaveBeenCalledWith("acceptEdits");
    expect(ref.current?.lines).toEqual(["/help "]);
  });

  it("dismisses autocomplete before delegating Escape", () => {
    const onEscape = vi.fn();
    const ref = draftRef();
    mount({ draftRef: ref, commands, onEscape, workDir: "/virtual" });
    press("/");
    press("", { escape: true });
    expect(onEscape).not.toHaveBeenCalled();
    press("\x1b");
    expect(onEscape).toHaveBeenCalledTimes(1);
    unmount();
    mount({ draftRef: draftRef(["text @one"]), onEscape, workDir: "/virtual" });
    press("", { escape: true });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("allows edits with submission locked but does not register hidden input while disabled", () => {
    const ref = draftRef(["draft"]);
    const onSubmit = vi.fn();
    mount({ draftRef: ref, submitDisabled: true, onSubmit });
    press("!");
    press("", { return: true });
    expect(ref.current?.lines).toEqual(["draft!"]);
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
    const clearRef: { current: (() => void) | null } = { current: null };
    mount({ draftRef: ref, disabled: true, clearRef });
    expect(terminal.input.current).toBeNull();
    expect(terminal.paste.current).toBeNull();
    act(() => {
      clearRef.current?.();
    });
    expect(ref.current?.lines).toEqual(["draft!"]);
  });

  it("clears submitted drafts even if onSubmit immediately unmounts the input", () => {
    const ref = draftRef(["/model "]);
    const onSubmit = vi.fn(() => {
      instance?.unmount();
    });
    mount({ draftRef: ref, onSubmit });
    press("", { return: true });
    expect(onSubmit).toHaveBeenCalledWith("/model");
    expect(ref.current).toEqual(draftRef().current);
    unmount();
    mount({ draftRef: ref });
    expect(ref.current?.lines).toEqual([""]);
  });
});
